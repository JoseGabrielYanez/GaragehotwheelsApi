/** Envuelve un handler async de Express 4 para que los errores lleguen al middleware de errores. */
export const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
