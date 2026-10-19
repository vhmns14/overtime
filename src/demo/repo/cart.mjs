// Cart math for the warung POS. Prices are whole Rupiah.
import { roundRupiah } from "./format.mjs";

export function lineTotal(item) {
  return item.price;
}

export function subtotal(items) {
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}

export function total(items, { discountPct = 0, taxPct = 11 } = {}) {
  const sub = subtotal(items);
  const discounted = sub - (sub * discountPct) / 100;
  return roundRupiah(discounted + (discounted * taxPct) / 100);
}
