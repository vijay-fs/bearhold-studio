'use client';

// Legacy /data-diff route. Merged into /compare with the "Tables"
// tab preselected — see /diff/page.tsx for the sibling redirect and
// /compare/page.tsx for the new workspace.

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function DataDiffRedirectInner() {
  const router = useRouter();
  const sp = useSearchParams();
  useEffect(() => {
    const params = new URLSearchParams();
    params.set('tab', 'tables');
    const src = sp.get('src') ?? sp.get('cid');
    if (src) params.set('src', src);
    const tgt = sp.get('tgt');
    if (tgt) params.set('tgt', tgt);
    router.replace(`/compare?${params.toString()}` as never);
  }, [router, sp]);
  return null;
}

export default function DataDiffLegacyPage() {
  return (
    <Suspense fallback={null}>
      <DataDiffRedirectInner />
    </Suspense>
  );
}
