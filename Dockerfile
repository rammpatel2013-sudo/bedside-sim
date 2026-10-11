FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py sim.py content.py ./
COPY content/ content/
COPY templates/ templates/
COPY static/ static/

# SQLite file + uploaded media live here — mount this as a volume so data survives rebuilds
ENV HALO_DB_PATH=/app/data/halo.db
RUN mkdir -p /app/data

EXPOSE 5000
# ONE worker on purpose: live sim rooms are held in memory. Threads handle the sockets.
CMD ["gunicorn", "-w", "1", "-k", "gthread", "--threads", "64", "--timeout", "0", "-b", "0.0.0.0:5000", "app:app"]
