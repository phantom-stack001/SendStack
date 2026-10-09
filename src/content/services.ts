export type ServiceItem = {
  index: string;
  title: string;
  description: string;
};

export const services: ServiceItem[] = [
  {
    index: "01",
    title: "Campaign delivery",
    description:
      "Plan and send transactional and marketing messages with clear ownership, consent tracking, and delivery feedback.",
  },
  {
    index: "02",
    title: "Operations support",
    description:
      "Keep sending domains authenticated, lists clean, and suppression rules applied so everyday delivery stays predictable.",
  },
  {
    index: "03",
    title: "Content systems",
    description:
      "Build reusable templates and review flows so teams publish consistent messages without reinventing every send.",
  },
  {
    index: "04",
    title: "Advisory",
    description:
      "Get practical guidance on DNS authentication, warmup, and deliverability hygiene before volume ramps up.",
  },
];
