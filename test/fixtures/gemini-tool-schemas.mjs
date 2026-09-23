// Reduced from the cached Zillow connector schema behind the observed Gemini
// 400 at properties.request.properties.propertyFiltersRequest.properties.bedrooms.
export function zillowRangeSchema() {
  return {
    type: "object",
    properties: {
      request: {
        $defs: {
          MinMaxInt: {
            type: "object",
            properties: {
              max: { type: "integer", format: "int32", description: "Maximum value" },
              min: { type: "integer", format: "int32", description: "Minimum value" },
            },
          },
        },
        type: "object",
        properties: {
          propertyFiltersRequest: {
            type: "object",
            properties: {
              bedrooms: {
                $ref: "#/$defs/MinMaxInt",
                description: "Bedrooms range filter. Do not add default values if min or max is not specified",
              },
            },
          },
        },
      },
    },
    required: ["request"],
  };
}

export function preservedGeminiSchemas() {
  return [
    {
      name: "valid_boolean_root",
      schema: {
        type: "object",
        $defs: { blocked: false },
        properties: {
          request: {
            type: "object",
            $defs: { blocked: { type: "string" } },
            properties: { value: { $ref: "#/$defs/blocked" } },
          },
        },
      },
    },
    {
      name: "embedded_resource",
      schema: {
        $id: "https://example.test/root",
        type: "object",
        $defs: { value: { type: "string" } },
        properties: {
          request: {
            $id: "https://example.test/request",
            type: "object",
            $defs: { value: { type: "integer" } },
            properties: { value: { $ref: "#/$defs/value", description: "A count" } },
          },
        },
      },
    },
    {
      name: "closed_object",
      schema: {
        type: "object",
        $defs: { closed: { type: "object", additionalProperties: false } },
        properties: {
          request: { $ref: "#/$defs/closed", properties: { value: { type: "string" } } },
        },
      },
    },
    {
      name: "ordinary_property_pointer",
      schema: {
        type: "object",
        properties: {
          original: { type: "integer" },
          alias: { $ref: "#/properties/original", description: "Same type" },
        },
      },
    },
  ];
}
