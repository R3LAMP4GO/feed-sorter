import { apiGet, apiPost } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface Me {
  id: string;
  email: string;
  tier: 'free' | 'pro' | 'studio';
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
}

export default async function BillingPage() {
  const me = await apiGet<Me>('/v1/me');

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold mb-1">Billing</h1>
      <p className="text-sm text-zinc-400 mb-6">{me.email}</p>

      <div className="rounded border border-zinc-800 bg-zinc-900/40 p-5 mb-4">
        <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Current plan</div>
        <div className="text-xl font-medium capitalize">{me.tier}</div>
        {me.currentPeriodEnd && (
          <div className="text-sm text-zinc-400 mt-1">
            Renews {new Date(me.currentPeriodEnd).toLocaleDateString()}
          </div>
        )}
        {me.trialEndsAt && (
          <div className="text-sm text-emerald-400 mt-1">
            Trial ends {new Date(me.trialEndsAt).toLocaleDateString()}
          </div>
        )}
      </div>

      {me.tier === 'free' ? <UpgradeCtas /> : <PortalCta />}
    </div>
  );
}

function UpgradeCtas() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <form action={startProCheckout}>
        <button
          type="submit"
          className="w-full rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-3 text-sm font-medium"
        >
          <span className="block text-base">Pro — $19/mo</span>
          <span className="block text-xs opacity-80">7-day free trial</span>
        </button>
      </form>
      <form action={startStudioCheckout}>
        <button
          type="submit"
          className="w-full rounded bg-indigo-600 hover:bg-indigo-500 px-4 py-3 text-sm font-medium"
        >
          <span className="block text-base">Studio — $49/mo</span>
          <span className="block text-xs opacity-80">Higher caps · multi-seat</span>
        </button>
      </form>
    </div>
  );
}

function PortalCta() {
  return (
    <form action={openPortal}>
      <button
        type="submit"
        className="rounded border border-zinc-700 hover:border-zinc-500 px-4 py-2 text-sm"
      >
        Manage subscription
      </button>
    </form>
  );
}

async function startProCheckout() {
  'use server';
  const { url } = await apiPost<{ url: string }>('/v1/billing/checkout', { plan: 'pro' });
  const { redirect } = await import('next/navigation');
  redirect(url);
}

async function startStudioCheckout() {
  'use server';
  const { url } = await apiPost<{ url: string }>('/v1/billing/checkout', { plan: 'studio' });
  const { redirect } = await import('next/navigation');
  redirect(url);
}

async function openPortal() {
  'use server';
  const { url } = await apiPost<{ url: string }>('/v1/billing/portal', {});
  const { redirect } = await import('next/navigation');
  redirect(url);
}
