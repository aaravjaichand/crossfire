"use client";

// The only client code on the binder. Everything else is printed markup.
export function PrintButton() {
  return (
    <button type="button" className="btn btn-solid" onClick={() => window.print()}>
      Print
    </button>
  );
}
