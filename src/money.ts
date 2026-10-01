import * as z from "zod";

export const sarCurrency = "SAR";
export const sarMinorUnitExponent = 2;
export const currencySchema = z.literal(sarCurrency);
