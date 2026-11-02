"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { canRead, canWrite } = require("../server/rules");

const A = "u_customerA", B = "u_customerB", D = "u_driver", O = "u_owner";

test("public site data: everyone reads, only staff write", () => {
  assert.ok(canRead("site/config", null, "view"));
  assert.ok(!canWrite("site/config", A, "interact"));
  assert.ok(canWrite("site/config", D, "admin"));
});

test("team roles: only the owner can change them", () => {
  assert.ok(canRead("site/roles", null, "view"));
  assert.ok(!canWrite("site/roles", D, "admin"));
  assert.ok(canWrite("site/roles", O, "owner"));
});

test("customers read and write only their own requests", () => {
  assert.ok(canRead(`requests/${A}`, A, "interact"));
  assert.ok(canWrite(`requests/${A}`, A, "interact"));
  assert.ok(!canRead(`requests/${A}`, B, "interact"));
  assert.ok(!canWrite(`requests/${A}`, B, "interact"));
  assert.ok(!canRead(`requests/${A}`, null, "view"));
  assert.ok(canRead(`requests/${A}`, D, "admin"));
});

test("decisions: customers read their own but can never write them", () => {
  assert.ok(canRead(`decisions/${A}`, A, "interact"));
  assert.ok(!canWrite(`decisions/${A}`, A, "interact"), "customer can't forge a confirmation");
  assert.ok(!canRead(`decisions/${A}`, B, "interact"));
  assert.ok(canWrite(`decisions/${A}`, D, "admin"));
});

test("customer records (verification, blocks) are staff-only", () => {
  assert.ok(!canRead(`customers/${A}`, A, "interact"));
  assert.ok(!canWrite(`customers/${A}`, A, "interact"));
  assert.ok(canWrite(`customers/${A}`, O, "owner"));
});

test("guests can't write anything; bad paths are rejected", () => {
  assert.ok(!canWrite("anything/x", null, "view"));
  assert.throws(() => canRead("../etc/passwd", A, "interact"));
  assert.throws(() => canRead("a//b", A, "interact"));
});
