export class AppError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class ConfigurationError extends AppError {}
export class NavigationError extends AppError {}
export class AuthenticationRequiredError extends AppError {}
export class CaptchaDetectedError extends AppError {}
export class PageStructureError extends AppError {}
export class SuspiciousResultError extends AppError {}
export class DatabaseError extends AppError {}
export class MessageDeliveryError extends AppError {}

export function errorDetails(error) {
  return {
    category: error?.name || 'Error',
    message: error?.message || String(error)
  };
}
