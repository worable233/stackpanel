'use client';
import type { ReactNode } from 'react';
import type { FrontendActionExecutor } from '@stackpanel/sdk';
// Runtime imports are replaced with host-owned client references.
export function AutoSubmitForm(_props: { formId: string; delay?: number }) {
  return null;
}
export interface CartCheckoutProps {
  lines: Array<{
    id: string;
    name: string;
    quantity: number;
    total: number;
    summary?: string | undefined;
    available?: boolean;
    controls?: ReactNode;
  }>;
  currency: string;
  locale?: string | undefined;
  methods: Array<{ id: string; label: string; providerId?: string; paymentMethod?: string }>;
  wallet?: FrontendActionExecutor | undefined;
  external?: FrontendActionExecutor | undefined;
  labels: { items: string; total: string; payment: string; submit: string; unavailable: string };
  resultRequested?: boolean;
  result?:
    | { id: string; status: string; total: number; currency: string; paymentUrl?: string | null }
    | null
    | undefined;
}

export function CartCheckout(_props: CartCheckoutProps) {
  return null;
}
