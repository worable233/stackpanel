import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowUpRight, CircleDashed } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from './card.js';
import { PageHeader } from './page-header.js';

/**
 * Fixed copy for the shared overview composition.
 *
 * `@stackpanel/ui` ships no interface translations (ADR-0016 §6): the plugin
 * that owns the page resolves these from its own catalog.
 */
export interface FeatureOverviewLabels {
  unavailable: string;
  manageTitle: string;
  manageDescription: string;
  activityDescription: string;
  empty: string;
}

export interface FeatureOverviewProps {
  title: string;
  description: string;
  metrics: Array<{ label: string; value: ReactNode; hint?: string }>;
  links: Array<{ label: string; description: string; href: string }>;
  activity?: { title: string; items: Array<{ label: string; detail?: string; href?: string }> };
  unavailable?: boolean;
  /** Localized copy. See {@link FeatureOverviewLabels}. */
  labels: FeatureOverviewLabels;
}

/** Shared composition, with business data and destinations supplied by the owning plugin. */
export function FeatureOverview({
  title,
  metrics,
  links,
  activity,
  unavailable,
  labels,
}: FeatureOverviewProps) {
  // Older plugins may still call this component without localized labels.
  // Keep the page usable instead of crashing the whole admin route.
  const copy = labels ?? {
    unavailable: '',
    manageTitle: '',
    manageDescription: '',
    activityDescription: '',
    empty: '',
  };
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <PageHeader title={title} />
      {unavailable ? (
        <p role="status" className="text-sm text-muted-foreground">
          {copy.unavailable}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {metrics.map((metric) => (
          <Card key={metric.label}>
            <CardHeader>
              <CardDescription>{metric.label}</CardDescription>
              <CardTitle className="text-3xl tabular-nums">
                {unavailable ? '—' : metric.value}
              </CardTitle>
            </CardHeader>
            {metric.hint ? (
              <CardContent>
                <p className="text-xs text-muted-foreground">{metric.hint}</p>
              </CardContent>
            ) : null}
          </Card>
        ))}
      </div>
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{copy.manageTitle}</CardTitle>
            <CardDescription>{copy.manageDescription}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="group flex items-center justify-between gap-4 rounded-lg p-3 transition-colors hover:bg-accent focus-visible:outline-ring"
              >
                <span className="flex flex-col gap-1">
                  <span className="text-sm font-medium">{link.label}</span>
                  <span className="text-xs text-muted-foreground">{link.description}</span>
                </span>
                <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
              </Link>
            ))}
          </CardContent>
        </Card>
        {activity ? (
          <Card>
            <CardHeader>
              <CardTitle>{activity.title}</CardTitle>
              <CardDescription>{copy.activityDescription}</CardDescription>
            </CardHeader>
            <CardContent>
              {activity.items.length ? (
                <ul className="flex flex-col divide-y">
                  {activity.items.map((item, index) => (
                    <li
                      key={index}
                      className="flex min-w-0 items-center justify-between gap-4 py-3 text-sm"
                    >
                      {item.href ? (
                        <Link className="truncate hover:underline" href={item.href}>
                          {item.label}
                        </Link>
                      ) : (
                        <span className="truncate">{item.label}</span>
                      )}
                      {item.detail ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {item.detail}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex min-h-32 flex-col items-center justify-center gap-3 text-muted-foreground">
                  <CircleDashed className="size-6 opacity-50" />
                  <span className="text-sm">{copy.empty}</span>
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
