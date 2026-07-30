import { Badge, Card, CardHeader, EmptyState, TableShell, Td, Th } from '@/components/ui';
import { createClient } from '@/lib/supabase/server';
import { requireTenant } from '@/lib/tenant';

/**
 * Knowledge and service catalogue.
 *
 * Read-only here. Editing is a form-heavy surface and is Phase 3 work; what matters
 * first is that an owner can *see* exactly what the assistant has been told, because
 * that is the only way to understand why it said something.
 *
 * The `needs_review` flag is the important column: scraped content stays out of
 * `business_ai_context` — and therefore out of every prompt — until a human approves
 * it, so anything flagged here is not yet in use.
 */
export default async function KnowledgePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await requireTenant(slug);
  const supabase = await createClient();

  const [servicesResult, knowledgeResult, areasResult] = await Promise.all([
    supabase
      .from('services')
      .select('id, name, description, price_text, duration_minutes, is_bookable, is_published')
      .eq('business_id', tenant.businessId)
      .order('sort_order'),
    supabase
      .from('knowledge_items')
      .select('id, kind, title, content, is_published, needs_review')
      .eq('business_id', tenant.businessId)
      .order('sort_order'),
    supabase
      .from('service_areas')
      .select('id, name, postcode_prefixes')
      .eq('business_id', tenant.businessId)
      .order('sort_order'),
  ]);

  const services = (servicesResult.data ?? []) as Array<{
    id: string;
    name: string;
    description: string | null;
    price_text: string | null;
    is_bookable: boolean;
    is_published: boolean;
  }>;
  const knowledge = (knowledgeResult.data ?? []) as Array<{
    id: string;
    kind: string;
    title: string | null;
    content: string;
    is_published: boolean;
    needs_review: boolean;
  }>;
  const areas = (areasResult.data ?? []) as Array<{
    id: string;
    name: string;
    postcode_prefixes: string[];
  }>;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Knowledge</h1>
        <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          Exactly what your assistant has been told. It will not offer a service or a
          price that is not on this page.
        </p>
      </div>

      <div>
        <h2 className="mb-3 text-[15px] font-semibold">Services and prices</h2>
        {services.length === 0 ? (
          <EmptyState
            title="No services yet"
            description="Until you add services, the assistant will take details but decline to describe or price anything."
          />
        ) : (
          <TableShell>
            <thead>
              <tr>
                <Th>Service</Th>
                <Th>Price</Th>
                <Th>Bookable</Th>
                <Th>Live</Th>
              </tr>
            </thead>
            <tbody>
              {services.map((service) => (
                <tr key={service.id}>
                  <Td>
                    <span className="font-medium">{service.name}</span>
                    {service.description ? (
                      <div className="mt-0.5 line-clamp-2 max-w-[420px] text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                        {service.description}
                      </div>
                    ) : null}
                  </Td>
                  <Td muted>{service.price_text ?? 'not published'}</Td>
                  <Td>{service.is_bookable ? <Badge tone="info">Yes</Badge> : '—'}</Td>
                  <Td>
                    {service.is_published ? <Badge tone="good">Live</Badge> : <Badge>Hidden</Badge>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </div>

      {areas.length > 0 ? (
        <Card>
          <CardHeader title="Areas covered" description="Used to spot out-of-area enquiries." />
          <ul className="flex flex-wrap gap-2">
            {areas.map((area) => (
              <li key={area.id}>
                <Badge>
                  {area.name}
                  {area.postcode_prefixes.length > 0 ? ` · ${area.postcode_prefixes.join(', ')}` : ''}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div>
        <h2 className="mb-3 text-[15px] font-semibold">FAQs and policies</h2>
        {knowledge.length === 0 ? (
          <EmptyState title="Nothing added yet" description="Run onboarding to pull this from your website." />
        ) : (
          <div className="space-y-3">
            {knowledge.map((item) => (
              <Card key={item.id}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge tone="info">{item.kind}</Badge>
                  {item.needs_review ? <Badge tone="warning">Awaiting your review — not in use</Badge> : null}
                  {!item.is_published ? <Badge>Hidden</Badge> : null}
                </div>
                {item.title ? <h3 className="text-[14px] font-semibold">{item.title}</h3> : null}
                <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  {item.content}
                </p>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
