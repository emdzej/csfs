/**
 * The demo, driven like a person would.
 *
 * The one part of the repository whose behaviour lives in a template, so the
 * one part nothing else runs. It reads the tree cross-origin, as a deployed
 * demo reads someone else's host.
 */
import { expect, origins, test } from "./fixtures.js";

test("opens an HTTP tree, steps into an archive and back, and previews files", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { demo, cross } = origins();
  await page.goto(demo);

  await page.getByLabel("HTTP tree URL").fill(`${cross}/data`);
  await page.getByRole("button", { name: "Open URL" }).click();
  const tree = page.locator("section.tree");
  await expect(tree.getByRole("button", { name: "stored.zip" })).toBeVisible();
  await expect(tree.getByRole("button", { name: "drawings/" })).toBeVisible();

  // Into an archive by `#`, read by range, and `..` back out of it.
  await tree.getByRole("button", { name: "stored.zip" }).click();
  await expect(tree.locator("code")).toHaveText("/stored.zip#/");
  await expect(tree.getByRole("button", { name: "inner.zip" })).toBeVisible();
  await tree.getByRole("button", { name: "inner.zip" }).click();
  await expect(tree.locator("code")).toHaveText("/stored.zip#/inner.zip#/");
  await tree.getByRole("button", { name: "..", exact: true }).click();
  await expect(tree.locator("code")).toHaveText("/stored.zip#/");
  await tree.getByRole("button", { name: "..", exact: true }).click();
  await expect(tree.locator("code")).toHaveText("/");

  // A text preview, then an image from a mounted archive.
  await tree.getByRole("button", { name: "top.txt" }).click();
  await expect(page.locator("section.preview pre")).toHaveText("at the top");
  await tree.getByRole("button", { name: "drawings/" }).click();
  await expect(tree.locator("code")).toHaveText("/drawings");

  expect(errors).toEqual([]);
});
