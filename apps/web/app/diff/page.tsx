'use client';

// Legacy /diff route. The workspace was merged with /data-diff into a
// single /compare page — this file exists so pre-merge bookmarks,
// palette entries, and shared links keep working. Redirects on mount
// with the tab preselected + any `cid` param preserved as `src`.

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function DiffRedirectInner() {
  const router = useRouter();
  const sp = useSearchParams();
  useEffect(() => {
    const params = new URLSearchParams();
    params.set('tab', 'schema');
    const src = sp.get('src') ?? sp.get('cid');
    if (src) params.set('src', src);
    const tgt = sp.get('tgt');
    if (tgt) params.set('tgt', tgt);
    router.replace(`/compare?${params.toString()}` as never);
  }, [router, sp]);
  return null;
}

export default function DiffLegacyPage() {
  return (
    <Suspense fallback={null}>
      <DiffRedirectInner />
    </Suspense>
  );
}
