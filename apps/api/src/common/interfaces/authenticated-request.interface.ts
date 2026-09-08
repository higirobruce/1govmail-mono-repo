import { Request } from 'express';

/** Shape of `req` inside guards-protected controllers (after JwtStrategy.validate). */
export interface AuthenticatedRequest extends Request {
  user: {
    sub: string;       // user UUID (from JWT payload)
    email: string;
    sessionId: string; // Session row backing this JWT (from Task 2's DB-backed validation)
  };
}
