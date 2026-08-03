export type SecurityUser = {
  id: string;
  email: string;
  passwordHash: string;
};

export type CreateSecurityUserInput = {
  email: string;
  passwordHash: string;
};

/**
 * Public security boundary for modules that need user credentials.
 *
 * Authentication depends on this contract rather than on the UsersModule
 * implementation or its persistence details.
 */
export interface UsersSecurityPort {
  findByEmail(email: string): Promise<SecurityUser | null>;
  create(input: CreateSecurityUserInput): Promise<SecurityUser | null>;
}

export const USERS_SECURITY_PORT = Symbol('USERS_SECURITY_PORT');
