import { validateHeaderValue } from 'node:http';

// Validate the exact Authorization value before readiness, budget reservation,
// DNS or HTTP work. This is an encoding check, not authentication or a guessed
// provider-key prefix. Never expose Node's exception or the credential value.
export function isValidBearerCredential(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1024 ||
    /\s/u.test(value) ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return false;
  try {
    validateHeaderValue('Authorization', `Bearer ${value}`);
    return true;
  } catch {
    return false;
  }
}
