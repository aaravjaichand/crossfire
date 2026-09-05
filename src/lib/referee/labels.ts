// Shared between the mock provider and the real audit_runs provider so a
// sample reads the same way whichever one built it.

export function invoiceLabel(vendorName: string, invoiceNumber: string): string {
  return `${vendorName} · ${invoiceNumber}`;
}

export function bankLabel(counterparty: string, reference: string): string {
  return `${counterparty} · ${reference}`;
}

// Refund and dispute references carry a trailing "for pay_..." clause that is
// too long for a list row.
export function dodoLabel(type: string, reference: string): string {
  return `Dodo ${type} · ${reference.split(" ")[0]}`;
}
