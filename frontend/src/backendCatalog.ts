import { api } from './api';
import { createBackendCatalog } from './utils/backendCatalog';

export const backendCatalog = createBackendCatalog((execKey) => api.getBackends(execKey));
