import unittest
from unittest.mock import patch

import psycopg
from sqlalchemy.exc import OperationalError

from app import create_app, db


class HealthEndpointTests(unittest.TestCase):
    def setUp(self):
        self.app = create_app({"TESTING": True, "SQLALCHEMY_DATABASE_URI": None})
        self.client = self.app.test_client()

    def test_health_returns_expected_json(self):
        response = self.client.get("/api/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "application/json")
        self.assertEqual(
            response.get_json(),
            {
                "status": "ok",
                "message": "Hello from the Venoms FC Flask backend!",
            },
        )

    def test_unknown_endpoint_returns_not_found(self):
        self.assertEqual(self.client.get("/api/missing").status_code, 404)

    def test_readiness_without_configuration_fails_explicitly(self):
        with self.assertLogs(self.app.logger, level="ERROR"):
            response = self.client.get("/api/ready")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(
            response.json, {"error": "Database and host login must be configured."}
        )

    def test_readiness_checks_a_database_without_creating_records(self):
        app = create_app({
            "TESTING": True,
            "SECRET_KEY": "test-only-key",
            "HOST_PASSWORD_HASH": "test-only-hash",
            "SQLALCHEMY_DATABASE_URI": "sqlite://",
            "SQLALCHEMY_ENGINE_OPTIONS": {},
        })
        with app.app_context():
            response = app.test_client().get("/api/ready")
            with db.engine.connect() as connection:
                tables = connection.exec_driver_sql(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).all()
            db.engine.dispose()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {"status": "ready"})
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(tables, [])

    def test_readiness_requires_host_login_even_when_database_is_available(self):
        app = create_app({
            "TESTING": True,
            "SECRET_KEY": "test-only-key",
            "HOST_PASSWORD_HASH": None,
            "SQLALCHEMY_DATABASE_URI": "sqlite://",
            "SQLALCHEMY_ENGINE_OPTIONS": {},
        })
        with app.app_context():
            with self.assertLogs(app.logger, level="ERROR"):
                response = app.test_client().get("/api/ready")
            db.engine.dispose()

        self.assertEqual(response.status_code, 503)

    def test_readiness_surfaces_database_failure_without_private_details(self):
        app = create_app({
            "TESTING": True,
            "SECRET_KEY": "test-only-key",
            "HOST_PASSWORD_HASH": "test-only-hash",
            "SQLALCHEMY_DATABASE_URI": "sqlite://",
            "SQLALCHEMY_ENGINE_OPTIONS": {},
        })
        with app.app_context():
            with patch.object(
                db.engine,
                "connect",
                side_effect=OperationalError("private query", {}, Exception("secret")),
            ):
                with self.assertLogs(app.logger, level="ERROR"):
                    response = app.test_client().get("/api/ready")
            db.engine.dispose()

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json, {"error": "Database operation failed. Please retry later."})
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertNotIn("secret", response.get_data(as_text=True))
        self.assertNotIn("private query", response.get_data(as_text=True))

    def test_db_check_without_configuration_fails_explicitly(self):
        result = self.app.test_cli_runner().invoke(args=["db-check"])

        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("Database is not configured", result.output)

    @patch("app.set_key")
    @patch("app.psycopg.connect", side_effect=psycopg.OperationalError("private details"))
    def test_failed_configuration_does_not_save_or_expose_password(
        self, connect, set_key
    ):
        result = self.app.test_cli_runner().invoke(
            args=["configure-db"], input="test-secret\ntest-secret\n"
        )

        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("Configuration was not saved", result.output)
        self.assertNotIn("test-secret", result.output)
        self.assertNotIn("private details", result.output)
        set_key.assert_not_called()

    @patch("app.set_key")
    @patch("app.psycopg.connect")
    def test_configuration_verifies_identity_and_saves_settings(self, connect, set_key):
        cursor = connect.return_value.__enter__.return_value.cursor
        cursor.return_value.__enter__.return_value.fetchone.return_value = (
            "venomsfc_app",
            "venomsfc_auction",
        )
        result = self.app.test_cli_runner().invoke(
            args=["configure-db"], input="test-secret\ntest-secret\n"
        )

        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(set_key.call_count, 5)
        self.assertNotIn("test-secret", result.output)
        self.assertIn("Connection verified", result.output)

    def test_db_check_surfaces_connection_failure_without_private_details(self):
        app = create_app({
            "TESTING": True,
            "SQLALCHEMY_DATABASE_URI": "sqlite://",
            "SQLALCHEMY_ENGINE_OPTIONS": {},
        })
        with app.app_context():
            with patch.object(
                db.engine,
                "connect",
                side_effect=OperationalError("private query", {}, Exception("secret")),
            ):
                result = app.test_cli_runner().invoke(args=["db-check"])

        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("Database query failed", result.output)
        self.assertNotIn("secret", result.output)


if __name__ == "__main__":
    unittest.main()
