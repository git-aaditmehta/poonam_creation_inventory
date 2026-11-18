/** Shared validation helpers — no business-data defaults. */

export type ValidationError = { field: string; message: string };

export function validateRequired(value: unknown, field: string): ValidationError | null {
  if (value === undefined || value === null || value === '') {
    return { field, message: `${field} is required` };
  }
  return null;
}

export function validatePositiveNumber(value: unknown, field: string): ValidationError | null {
  if (typeof value !== 'number' || isNaN(value) || value < 0) {
    return { field, message: `${field} must be a non-negative number` };
  }
  return null;
}

export function validatePositiveInteger(value: unknown, field: string): ValidationError | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { field, message: `${field} must be a non-negative integer` };
  }
  return null;
}

export function validateStrictPositiveNumber(value: unknown, field: string): ValidationError | null {
  if (typeof value !== 'number' || isNaN(value) || value <= 0) {
    return { field, message: `${field} must be a positive number` };
  }
  return null;
}

/**
 * Plated Jewelry, Raw Jewelry and Stones are counted (quantities), so they take whole numbers only.
 * Only Foil is weighed and may have decimals. Decimals are refused, never silently rounded.
 */
export function allowsDecimals(category: string): boolean {
  return category === 'foil';
}

export function validateWholeNumberFor(category: string, value: unknown, field: string): ValidationError | null {
  if (allowsDecimals(category) || typeof value !== 'number' || !Number.isFinite(value)) return null; // other checks report bad numbers
  if (!Number.isInteger(value)) {
    return { field, message: `${field} must be a whole number (decimals are only allowed for Foil)` };
  }
  return null;
}

const VALID_UNITS = ['PC', 'KGS', 'SET', 'JODI', 'GRMS'] as const;
export type Unit = typeof VALID_UNITS[number];

export function validateUnit(value: unknown, field: string): ValidationError | null {
  if (!VALID_UNITS.includes(value as Unit)) {
    return { field, message: `${field} must be one of: ${VALID_UNITS.join(', ')}` };
  }
  return null;
}

export function validateString(value: unknown, field: string, maxLength = 255): ValidationError | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { field, message: `${field} must be a non-empty string` };
  }
  if (value.length > maxLength) {
    return { field, message: `${field} must be ${maxLength} characters or less` };
  }
  return null;
}

export function collectErrors(checks: (ValidationError | null)[]): ValidationError[] {
  return checks.filter((e): e is ValidationError => e !== null);
}

/** Parse cost price from user input (rupees) to integer cents/paisa. */
export function rupeesToPaisa(rupees: number): number {
  return Math.round(rupees * 100);
}

/** Convert stored paisa back to rupees for display. */
export function paisaToRupees(paisa: number): number {
  return paisa / 100;
}
