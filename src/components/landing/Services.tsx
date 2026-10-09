import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { services } from "@/content/services";

export function Services() {
  return (
    <section className="section" id="services" aria-labelledby="services-heading">
      <div className="shell">
        <div className="section-head">
          <p className="kicker">Services</p>
          <h2 id="services-heading">What we help with</h2>
          <p className="section-intro">
            Practical capabilities for teams that need reliable outbound communication—not another
            black-box marketing suite.
          </p>
        </div>
        <ol className="service-list">
          {services.map((service) => (
            <li key={service.title} className="service-item">
              <span className="service-index">{service.index}</span>
              <Card className="border-0 bg-transparent py-0 shadow-none">
                <CardHeader className="gap-1 px-0">
                  <CardTitle className="text-[1.12rem] font-bold tracking-tight">
                    {service.title}
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-0 pt-0">
                  <p className="m-0 max-w-[42rem] text-[var(--muted)]">{service.description}</p>
                </CardContent>
              </Card>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
