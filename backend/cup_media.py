from io import BytesIO
from pathlib import Path
import re
import secrets
import warnings

from flask import Blueprint, current_app, jsonify, request, send_from_directory
from PIL import Image, ImageOps, UnidentifiedImageError

from cup_auth import check_cup_csrf, cup_host_required


cup_media = Blueprint("cup_media", __name__, url_prefix="/api/cup")
IMAGE_NAME = re.compile(r"[a-f0-9]{32}\.jpg\Z")


def _folder():
    folder = Path(current_app.config["CUP_UPLOAD_FOLDER"]).resolve()
    auction_folder = Path(current_app.config["UPLOAD_FOLDER"]).resolve()
    if folder == auction_folder or auction_folder in folder.parents or folder in auction_folder.parents:
        raise ValueError("Cup and auction image folders must be separate.")
    return folder


def valid_cup_media_path(value):
    prefix = "/api/cup/media/"
    if not isinstance(value, str) or not value.startswith(prefix):
        return False
    name = value[len(prefix):]
    return bool(IMAGE_NAME.fullmatch(name)) and (_folder() / name).is_file()


@cup_media.post("/uploads")
@cup_host_required
def upload_cup_image():
    error = check_cup_csrf()
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
                image = ImageOps.exif_transpose(original).convert("RGB")
                image.thumbnail((1600, 1600))
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError,
            Image.DecompressionBombWarning):
        return jsonify(error="Invalid or unsafe image. Choose another JPEG, PNG, or WebP."), 400
    try:
        folder = _folder()
        folder.mkdir(parents=True, exist_ok=True)
        name = f"{secrets.token_hex(16)}.jpg"
        with (folder / name).open("xb") as stream:
            image.save(stream, format="JPEG", quality=88)
    except (OSError, ValueError):
        current_app.logger.error("Cup image storage failed or overlaps the auction image folder.")
        return jsonify(error="Cup image could not be saved. Check separate local storage and retry."), 503
    return jsonify(path=f"/api/cup/media/{name}"), 201


@cup_media.get("/media/<name>")
def serve_cup_image(name):
    if not IMAGE_NAME.fullmatch(name):
        return jsonify(error="Image not found."), 404
    try:
        folder = _folder()
    except ValueError:
        current_app.logger.error("Cup image folder overlaps the auction image folder.")
        return jsonify(error="Cup image storage is misconfigured."), 503
    response = send_from_directory(folder, name)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response
