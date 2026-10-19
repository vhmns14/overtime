import { test } from "node:test";
import assert from "node:assert/strict";
import { subtotal, total } from "../src/cart.mjs";

test("subtotal adds prices", () => {
  assert.equal(subtotal([{ name: "Es teh", price: 5000 }, { name: "Nasi rames", price: 15000 }]), 20000);
});

test("total applies the discount, then PPN 11%", () => {
  assert.equal(total([{ name: "Kopi tubruk", price: 10000 }], { discountPct: 10 }), 9990);
});
