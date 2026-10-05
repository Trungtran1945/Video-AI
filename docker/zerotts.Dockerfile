FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
# Reproducible locked deps for ZeroTTS ONNX service (no torch).
RUN pip install --no-cache-dir "onnxruntime>=1.17" "numpy>=1.26" "soundfile>=0.12"
COPY backend/scripts/zerotts_service.py ./zerotts_service.py
ENV ZEROTTS_HOST=0.0.0.0 \
    ZEROTTS_PORT=5005 \
    ZEROTTS_THREADS=4 \
    ZEROTTS_CONCURRENCY=1 \
    ZEROTTS_MAX_INFLIGHT_REQUESTS=8 \
    ZEROTTS_MAX_BODY_BYTES=65536 \
    ZEROTTS_MAX_TEXT_CHARS=2000
EXPOSE 5005
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD python -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5005/health',timeout=4).status==200 else 1)"
CMD ["python", "zerotts_service.py"]
