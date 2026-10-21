import { claimAgentCode } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { errorResponse, readJson, SMALL_JSON_BYTES } from "@/lib/http";

/** Called by `mooz-agent connect`: trade a one-time code for a pending join request. */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = await readJson(req, SMALL_JSON_BYTES);
    const claim = claimAgentCode(getDb(), { code: body.code, name: body.name });
    return Response.json(claim, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
