# Camera-less demo deploy for SteadyPT (Cloud Run / Render).
# Runs the FastAPI app in PF_DEMO mode: the synthetic squat set streams to the
# dashboard, so the public submission link animates with no webcam, OpenCV, or
# MediaPipe in the image.
FROM python:3.11-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PF_DEMO=1

COPY requirements-deploy.txt ./
RUN pip install --no-cache-dir -r requirements-deploy.txt

COPY . .

# Cloud Run injects PORT (defaults to 8080). Bind it.
ENV PORT=8080
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-8080}"]
