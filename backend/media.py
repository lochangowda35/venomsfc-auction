from io import BytesIO
import os
from pathlib import Path
import re
import secrets
import tempfile
import warnings

from flask import Blueprint, current_app, jsonify, request, send_from_directory
from PIL import Image, UnidentifiedImageError

from auth import check_csrf, host_required


media = Blueprint("media", __name__, url_prefix="/api")
MEDIA_NAME = re.compile(r"[a-f0-9]{32}\.(?:jpg|png|webp)\Z")


def valid_media_path(value):
    from branding import BRANDING_FOLDER, TEAM_LOGOS
    if isinstance(value, str) and value in TEAM_LOGOS:
        return (BRANDING_FOLDER / value.rsplit("/", 1)[1]).is_file()
    prefix = "/api/media/"
    if not isinstance(value, str) or not value.startswith(prefix):
        return False
    name = value[len(prefix):]
    return bool(MEDIA_NAME.fullmatch(name)) and (
        Path(current_app.config["UPLOAD_FOLDER"]) / name
    ).is_file()


@media.post("/uploads")
@host_required
def upload():
    error = check_csrf()
    if error:
        return error
    file = request.files.get("file")
    if file is None or set(request.files) != {"file"} or request.form:
        return jsonify(error="Upload one image using the file field."), 400
    contents = file.read(5 * 1024 * 1024 + 1)
    if len(contents) > 5 * 1024 * 1024:
        return jsonify(error="Image must be at most 5 MB."), 413
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(contents)) as original:
                if original.format not in {"JPEG", "PNG", "WEBP"}:
                    return jsonify(error="Use a JPEG, PNG, or WebP image."), 400
                if original.width * original.height > 16_000_000:
                    return jsonify(error="Image must contain at most 16 million pixels."), 400
                original.load()
                from PIL import ImageOps
                image = ImageOps.exif_transpose(original).convert("RGB")
                image.thumbnail((1600, 1600))
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError,
            Image.DecompressionBombWarning):
        return jsonify(error="Invalid or unsafe image. Choose another JPEG, PNG, or WebP."), 400
    folder = Path(current_app.config["UPLOAD_FOLDER"])
    name = secrets.token_hex(16) + ".jpg"
    try:
        folder.mkdir(parents=True, exist_ok=True)
        image.save(folder / name, format="JPEG", quality=88)
    except OSError:
        current_app.logger.error("Image storage failed; check upload folder permissions and disk space.")
        return jsonify(error="Image could not be saved. Check local storage and retry."), 503
    return jsonify(path=f"/api/media/{name}"), 201


@media.put("/media-restore/<name>")
@host_required
def restore(name):
    """One-time migration helper: re-create an existing image under its original name."""
    if not current_app.config.get("ALLOW_MEDIA_RESTORE"):
        return jsonify(error="Not found."), 404
    error = check_csrf()
    if error:
        return error
    if not MEDIA_NAME.fullmatch(name):
        return jsonify(error="Invalid image name."), 400
    file = request.files.get("file")
    if file is None or set(request.files) != {"file"} or request.form:
        return jsonify(error="Upload one image using the file field."), 400
    contents = file.read(5 * 1024 * 1024 + 1)
    if len(contents) > 5 * 1024 * 1024:
        return jsonify(error="Image must be at most 5 MB."), 413
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(contents)) as image:
                if image.format not in {"JPEG", "PNG", "WEBP"}:
                    return jsonify(error="Use a JPEG, PNG, or WebP image."), 400
                if image.width * image.height > 16_000_000:
                    return jsonify(error="Image must contain at most 16 million pixels."), 400
                image.verify()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError,
            Image.DecompressionBombWarning):
        return jsonify(error="Invalid image."), 400
    folder = Path(current_app.config["UPLOAD_FOLDER"])
    target = folder / name
    temporary = None
    try:
        folder.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=folder, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(contents)
        # Publish a complete image without ever replacing an existing filename.
        try:
            os.link(temporary, target)
        except FileExistsError:
            if not target.is_file():
                raise OSError("The image path is not a file.") from None
            return jsonify(path=f"/api/media/{name}", existed=True), 200
    except OSError:
        current_app.logger.error("Image restore failed; check upload folder permissions and disk space.")
        return jsonify(error="Image could not be restored. Check local storage and retry."), 503
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                current_app.logger.error("Image restore temporary-file cleanup failed; check local storage.")
    return jsonify(path=f"/api/media/{name}", existed=False), 201


@media.get("/media/<name>")
def serve_image(name):
    if not MEDIA_NAME.fullmatch(name):
        return jsonify(error="Image not found."), 404
    response = send_from_directory(current_app.config["UPLOAD_FOLDER"], name)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response
