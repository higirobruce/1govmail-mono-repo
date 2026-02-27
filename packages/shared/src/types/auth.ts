export interface LoginRequest {
  email: string;
  password: string;
  zimbraHost: string;
}

export interface LoginResponse {
  accessToken: string;
  user: AuthUser;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  zimbraHost: string;
}
