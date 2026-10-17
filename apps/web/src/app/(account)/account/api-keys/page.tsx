import { redirect } from 'next/navigation';

/** Compatibility for saved links; key management now lives in account settings. */
export default function AccountApiKeysPage() {
  redirect('/account/settings#security');
}
