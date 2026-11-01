FROM python:3.12-slim
WORKDIR /app
COPY qiskit_service/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY qiskit_service ./qiskit_service
RUN useradd --create-home --uid 10001 qiskit
USER qiskit
EXPOSE 8001
CMD ["python", "-m", "qiskit_service.server", "--host", "0.0.0.0", "--port", "8001"]
