import { treeDepth } from "./treeDepth.fromJson.ts"
const tree = {"val":1,"left":{"val":2,"left":{"val":4,"left":null,"right":null},"right":null},"right":{"val":3,"left":null,"right":{"val":5,"left":null,"right":{"val":6,"left":null,"right":null}}}}
async function main() {
  const result = await treeDepth(tree)
  process.stdout.write(JSON.stringify({ ok: true, result }))
}
main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e) }))
  process.exit(1)
})