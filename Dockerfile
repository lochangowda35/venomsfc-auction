# Builds React separately from the production Flask/Waitress runtime.
FROM node:22-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
COPY --from=frontend /app/frontend/dist /app/frontend/dist
RUN useradd --uid 10001 --create-home venoms \
    && mkdir -p /data/uploads /data/backups \
    && chown -R venoms:venoms /data
USER venoms
EXPOSE 8080
CMD ["sh", "-c", "python -m flask --app app db upgrade && exec python -c \"import os; from waitress import serve; from app import create_app; serve(create_app(), host='0.0.0.0', port=int(os.environ.get('PORT', '8080')), threads=4)\""]
