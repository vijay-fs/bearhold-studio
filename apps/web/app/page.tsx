import Link from 'next/link';
import { Database, Network, Workflow } from 'lucide-react';

export default function HomePage() {
  return (
    <main className="container py-16">
      <header className="mb-12">
        <h1 className="text-4xl font-semibold tracking-tight">Bearhold Studio</h1>
        <p className="mt-3 max-w-2xl text-base text-muted-foreground">
          Cross-platform database management studio. Connect to any engine, run queries with
          a real editor, and visualize your schema as an ER diagram.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <FeatureCard
          icon={<Database className="h-5 w-5" />}
          title="Multi-engine"
          description="Postgres in Phase 1 — MySQL, Mongo, Redis, Cassandra, and more on the way."
        />
        <FeatureCard
          icon={<Workflow className="h-5 w-5" />}
          title="ER diagrams"
          description="Visualize tables, primary keys, and foreign keys. Auto-layout with Dagre."
        />
        <FeatureCard
          icon={<Network className="h-5 w-5" />}
          title="Secure connections"
          description="Basic, SSH-key, and SSH-tunneled connections with strict host verification."
        />
      </section>

      <footer className="mt-16 border-t pt-6 text-sm text-muted-foreground">
        <p>
          Phase 1 in development. See{' '}
          <Link href="/connections" className="font-medium text-foreground underline">
            connections
          </Link>{' '}
          to add your first database.
        </p>
      </footer>
    </main>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
        {icon}
      </div>
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
