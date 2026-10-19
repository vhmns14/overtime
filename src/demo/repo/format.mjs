// Rupiah has no coins below Rp 10 in daily use: round to the nearest 10.
export function roundRupiah(n) {
  return Math.round(n / 10) * 10;
}

export function formatRupiah(n) {
  return "Rp " + roundRupiah(n).toLocaleString("id-ID");
}
