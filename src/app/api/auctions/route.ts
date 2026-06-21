import { getStore } from "@/lib/store";
import { ok, fail } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/** Create a new OPEN auction. */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      title?: string;
      deadline?: string;
    };
    const meta = await getStore().createAuction({
      title: body.title,
      deadline: body.deadline,
    });
    return ok(meta, 201);
  } catch (err) {
    return fail(err);
  }
}
