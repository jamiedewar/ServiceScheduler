FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    LEGEND_SCHEDULER_HOST=0.0.0.0 \
    LEGEND_SCHEDULER_PORT=4173

WORKDIR /app

COPY backend.py index.html app.js styles.css README.md ./
COPY supabase ./supabase

RUN mkdir -p /app/data/attachments

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python3 -c "import json,os,urllib.request; port=os.environ.get('LEGEND_SCHEDULER_PORT','4173'); data=json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=3)); raise SystemExit(0 if data.get('ok') else 1)"

CMD ["sh", "-c", "python3 backend.py --host ${LEGEND_SCHEDULER_HOST} --port ${LEGEND_SCHEDULER_PORT} --db /app/data/scheduler.sqlite3"]
