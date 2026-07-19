import { createRequire } from "node:module";
export function llm_version() {
    // "Return the installed version of llm"
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json");
    return pkg.version;
}
llm_version.description =
    "Return the installed version of llm";
function pad(n) {
    return String(n).padStart(2, "0");
}
export function llm_time() {
    // "Returns the current time, as local time and UTC"
    const now = new Date();
    const utcTime = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ` +
        `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`;
    const localTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
        `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    // getTimezoneOffset() is minutes *behind* UTC (positive west of UTC)
    const offsetMinutesTotal = -now.getTimezoneOffset();
    const offsetHours = Math.floor(offsetMinutesTotal / 60);
    const offsetMinutes = ((offsetMinutesTotal % 60) + 60) % 60;
    const timezoneOffset = `UTC${offsetHours >= 0 ? "+" : ""}${String(offsetHours).padStart(2, "0")}:${pad(offsetMinutes)}`;
    // DST detection: compare against January/July offsets
    const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
    const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
    const isDst = now.getTimezoneOffset() < Math.max(jan, jul);
    const localTzName = Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
        .formatToParts(now)
        .find((p) => p.type === "timeZoneName")?.value ?? "";
    return {
        utc_time: utcTime,
        utc_time_iso: now.toISOString(),
        local_timezone: localTzName,
        local_time: localTime,
        timezone_offset: timezoneOffset,
        is_dst: isDst,
    };
}
llm_time.description =
    "Returns the current time, as local time and UTC";
