import { productionConfigErrors } from "./lib/production-config";

const errors = productionConfigErrors(process.env);
if (errors.length) {
  console.error(
    "Production configuration rejected:\n" +
      errors.map((e) => "- " + e).join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log(
    "Production environment shape validated. Database connectivity, DNS, TLS and business settings require separate checks.",
  );
}
