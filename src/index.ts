import { Hono } from "hono"
import { initDB } from "./lib/db"
import inspectorRoute from "./routes/inspector"
import hrRoute from "./routes/hr"
import apiRoute from "./routes/api"

const app = new Hono()
const PORT = Number(process.env.PORT || 3000)

app.get("/health", (c) => c.text("ok"))

app.get("/", (c) => c.redirect("/inspect"))
app.route("/inspect", inspectorRoute)
app.route("/hr", hrRoute)
app.route("/api", apiRoute)

app.notFound((c) => c.text("404 Not Found", 404))

await initDB()

export default { port: PORT, fetch: app.fetch, idleTimeout: 90 }
