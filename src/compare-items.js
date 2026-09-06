export function normalizeItem(item) {
  return {
    asin: String(item.asin).trim().toUpperCase(),
    title: item.title?.trim() || null,
    url: item.url?.trim() || null
  };
}

export function compareItems({ currentItems, activeItems, historicalItems }) {
  const current = new Map(currentItems.map((item) => {
    const normalized = normalizeItem(item);
    return [normalized.asin, normalized];
  }));
  const active = new Set(activeItems.map((item) => item.asin.toUpperCase()));
  const historical = new Set(historicalItems.map((item) => item.asin.toUpperCase()));

  return {
    currentItems: [...current.values()],
    newItems: [...current.values()].filter((item) => !historical.has(item.asin)),
    reactivatedItems: [...current.values()].filter((item) => historical.has(item.asin) && !active.has(item.asin)),
    removedItems: [...active].filter((asin) => !current.has(asin))
  };
}
