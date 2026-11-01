declare namespace Cloudflare {
  interface Env {
    QUBIT_STANDALONE?: string;
    OWNER_ACCESS_KEY?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
    CHAT_MASTER_KEY?: string;
    QISKIT_SERVICE_URL?: string;
    QISKIT_SERVICE_TOKEN?: string;
    IBM_QUANTUM_API_KEY?: string;
    IBM_QUANTUM_CRN?: string;
    IBM_QUANTUM_PLAN_MODE?: string;
    IBM_QUANTUM_FREE_PLAN_ID?: string;
    IBM_QUANTUM_ALLOW_PAID?: string;
  }
}
