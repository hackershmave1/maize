# Generating the forge template (decompilable .NET DLL)

The forge (`moqesh/forge.py`) serves decoy binaries with embedded credentials.
To make the decoy a **real, decompilable .NET DLL** (dnSpy/ILSpy) without
requiring the .NET SDK at runtime, it starts from a **pre-forged template** that
is generated **once, offline**, and whose bytes are then patched per deployment.

If the template is missing, the forge degrades to a PE binary with the
credentials embedded in cleartext (recoverable with `strings`). Everything keeps
working; you only lose the "pretty" decompilation.

## Requirement

The template MUST contain these fixed-width literals (patching respects their
exact length so the PE metadata does not shift):

| Field              | Placeholder (ASCII)                 | Length   |
|--------------------|-------------------------------------|----------|
| connection_string  | `MQCONN__` + `0` × 120              | 128      |
| internal_api_base  | `MQAPI__` + `0` × 57                | 64       |
| bearer_token       | `MQBEARER__` + `0` × 118            | 128      |

## Steps (with the .NET SDK on a build machine)

1. Create a class library project:

   ```bash
   dotnet new classlib -n PortalTemplate -o portal-template
   ```

2. Replace `Class1.cs` with a class that holds the placeholders as constants:

   ```csharp
   namespace Portal.Internal
   {
       internal static class AppConfig
       {
           public const string ConnectionString =
               "MQCONN__000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
           public const string InternalApiBase =
               "MQAPI__000000000000000000000000000000000000000000000000000";
           // Service token (in real life it would be encrypted; here it is a constant for the decoy).
           public const string ServiceToken =
               "MQBEARER__000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
       }
   }
   ```

3. Build in Release and copy the DLL into the package assets:

   ```bash
   dotnet build -c Release portal-template
   cp portal-template/bin/Release/*/PortalTemplate.dll moqesh/assets/portal_template.dll
   ```

The forge detects `moqesh/assets/portal_template.dll` automatically. To use
another path, pass it when constructing `AssemblyForge(template_path=...)`.

> Note: the placeholders are UTF-16 literals in the PE's `#US` heap; patching
> looks for their UTF-16LE encoding and replaces it with the deployment's value
> (padded with deterministic base62 to the same length).
