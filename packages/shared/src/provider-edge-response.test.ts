import { describe, expect, it } from "vitest";
import {
  detectEdgeBlock,
  detectEdgeBlockInMessage,
  edgeBlockReason,
} from "./provider-edge-response.js";

/** The opening of the page Cloudflare answers a blocked route with. */
const CLOUDFLARE_PAGE = [
  "<!DOCTYPE html>",
  '<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->',
  "<head>",
  "<title>Attention Required! | Cloudflare</title>",
  '<meta charset="UTF-8" />',
  "</head>",
].join("\n");

/** An API's own refusal: JSON, with the status that carries its meaning. */
const JSON_FORBIDDEN = JSON.stringify({
  error: { message: "You do not have access to the model claude-opus-4-8.", type: "permission_error" },
});

describe("detectEdgeBlock", () => {
  it("reads a Cloudflare block page as an edge block, not an auth failure", () => {
    expect(
      detectEdgeBlock({
        status: 403,
        contentType: "text/html; charset=UTF-8",
        server: "cloudflare",
        body: CLOUDFLARE_PAGE,
      }),
    ).toEqual({ edge: "cloudflare", status: 403 });
  });

  it("still reads it without the server header", () => {
    // The runtime classifier sees the body folded into a message and no headers
    // at all, so the signature has to be recoverable from the document itself.
    expect(
      detectEdgeBlock({ status: 403, contentType: "text/html", body: CLOUDFLARE_PAGE }),
    ).toEqual({ edge: "cloudflare", status: 403 });
  });

  it("leaves a provider's own JSON 403 an authorization failure", () => {
    // Some gateways answer 403 for a key that lacks a particular model. That is
    // a permission verdict on the credential, so it must not be reclassified.
    expect(
      detectEdgeBlock({ status: 403, contentType: "application/json", body: JSON_FORBIDDEN }),
    ).toBeUndefined();
  });

  it("never treats 401 as an edge block", () => {
    // A WAF challenge is never a 401, so a 401 stays an auth verdict even when
    // the body is a document.
    expect(
      detectEdgeBlock({ status: 401, contentType: "text/html", body: CLOUDFLARE_PAGE }),
    ).toBeUndefined();
  });

  it("ignores a markup 404 that names no intermediary", () => {
    const html404 = "<!DOCTYPE html><html><head><title>Not Found</title></head></html>";
    expect(detectEdgeBlock({ status: 404, contentType: "text/html", body: html404 })).toBeUndefined();
  });

  it("reports a markup block even when the page names no intermediary", () => {
    // The API never answers a failure with a document, so a 503 document is an
    // edge answer whether or not it signs itself.
    const unnamed = "<!DOCTYPE html><html><head><title>Service unavailable</title></head></html>";
    expect(detectEdgeBlock({ status: 503, contentType: "text/html", body: unnamed })).toEqual({
      status: 503,
    });
  });

  it("leaves a healthy JSON failure alone whatever its status", () => {
    expect(
      detectEdgeBlock({ status: 503, contentType: "application/json", body: '{"error":"busy"}' }),
    ).toBeUndefined();
    expect(
      detectEdgeBlock({ status: 200, contentType: "application/json", body: '{"data":[]}' }),
    ).toBeUndefined();
  });

  it("reads a challenge served with a success status", () => {
    // A JS challenge can arrive as 200 with the interstitial as the body; the
    // phrase is conclusive on its own. It names no intermediary, so only the
    // status is reported.
    expect(
      detectEdgeBlock({
        status: 200,
        contentType: "text/html",
        body: "<!DOCTYPE html><html><body>Just a moment...</body></html>",
      }),
    ).toEqual({ status: 200 });
  });

  it("names the intermediary from the server header when the body is generic", () => {
    expect(
      detectEdgeBlock({
        status: 403,
        contentType: "text/html",
        server: "AkamaiGHost",
        body: "<!DOCTYPE html><html><body>Access Denied</body></html>",
      }),
    ).toEqual({ edge: "akamai", status: 403 });
  });
});

describe("detectEdgeBlockInMessage", () => {
  it("recognizes a folded '<status>: <body>' failure", () => {
    // This is the shape the runtime actually holds: pi-ai collapses the
    // response into one string, so the markup is not at the start.
    const folded = `403: ${CLOUDFLARE_PAGE}`;
    expect(detectEdgeBlockInMessage(403, folded)).toEqual({ edge: "cloudflare", status: 403 });
  });

  it("recognizes a challenge page that arrived without a status", () => {
    expect(detectEdgeBlockInMessage(undefined, CLOUDFLARE_PAGE)).toEqual({ edge: "cloudflare" });
  });

  it("leaves a JSON body alone", () => {
    expect(detectEdgeBlockInMessage(403, `403: ${JSON_FORBIDDEN}`)).toBeUndefined();
  });

  it("leaves a body-less status alone", () => {
    expect(detectEdgeBlockInMessage(403, "403 status code (no body)")).toBeUndefined();
  });
});

describe("edgeBlockReason", () => {
  it("quotes the phrase worth showing", () => {
    expect(edgeBlockReason(CLOUDFLARE_PAGE)).toBe("Attention Required");
  });

  it("returns nothing for a body without one", () => {
    expect(edgeBlockReason("<html><body>nope</body></html>")).toBeUndefined();
  });
});
