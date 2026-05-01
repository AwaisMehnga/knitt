export default function errorHandler(err, req, res, next) {
  console.error(err.stack);

  const statusCode = err.statusCode || 500;
  const error =
    statusCode >= 500 ? "Internal Server Error" : "Request Failed";

  res.status(statusCode).json({
    error,
    code: err.code || null,
    message: err.message || "Something went wrong.",
  });
}
