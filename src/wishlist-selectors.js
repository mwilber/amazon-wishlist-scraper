export const WISHLIST_CONTAINERS = ['#g-items', '#g-items-grid'];
export const WISHLIST_CONTAINER_SELECTOR = WISHLIST_CONTAINERS.join(', ');
export const WISHLIST_ROW_SELECTOR = WISHLIST_CONTAINERS.flatMap((container) => [
  `${container} > li[data-itemid]`,
  `${container} .g-item-sortable`,
  `${container} [data-asin]`
]).join(', ');
