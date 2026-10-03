export interface InboundObservation {
  rowReady: boolean;
  vendorRequests: readonly string[];
  deliveryProcessed: boolean;
  reportedAt: string;
  summary: string;
}

export function deliverySettled(
  observed: InboundObservation,
  previousReport: string,
  vendorPath: string,
): boolean {
  return (
    observed.rowReady &&
    observed.vendorRequests.join() === vendorPath &&
    observed.deliveryProcessed &&
    observed.reportedAt !== previousReport &&
    observed.summary.includes("deliveries processed 1, rejected 0, duplicate 0")
  );
}

export function restorationSettled(
  observed: InboundObservation,
  previousReport: string,
  itemId: string,
): boolean {
  return (
    observed.rowReady &&
    observed.reportedAt !== previousReport &&
    observed.summary.includes(
      `title on ${itemId} was changed in Marfa and put back`,
    )
  );
}
