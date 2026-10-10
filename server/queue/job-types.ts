export type CampaignDispatchJobData = {
  campaignId: string;
};

export type EmailProcessingJobData = {
  deliveryJobId: string;
};

/** BullMQ custom job IDs must not contain ":". */
export function emailProcessingBullmqJobId(deliveryJobId: string) {
  return `email-${deliveryJobId}`;
}

export function campaignDispatchBullmqJobId(campaignId: string, generation: number) {
  return `dispatch-${campaignId}-${generation}`;
}
