import assert from "node:assert/strict";
import { test } from "node:test";
import { aCentavos } from "../apps/panel/src/lib/formato.ts";

test("importes como se escriben en Argentina", () => {
  assert.equal(aCentavos("40.000"), 4_000_000);
  assert.equal(aCentavos("1.250.000"), 125_000_000);
  assert.equal(aCentavos("150.000,50"), 15_000_050);
  assert.equal(aCentavos("$ 1.234,5"), 123_450);
  assert.equal(aCentavos("1234,56"), 123_456);
  assert.equal(aCentavos("1234.56"), 123_456);
  assert.equal(aCentavos("-1.000"), -100_000);
  assert.equal(aCentavos("500"), 50_000);
  for (const malo of ["", "abc", "1,2,3", "12.3456", "1.00.0"]) assert.ok(Number.isNaN(aCentavos(malo)), malo);
});
