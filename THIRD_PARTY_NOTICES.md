# Third-party notices

## "72" typeface (SAP)

The web app bundles three weights of the SAP "72" typeface as WOFF2 files in
`packages/web/public/fonts/` (`72-Regular.woff2`, `72-Semibold.woff2`, `72-Bold.woff2`).

- Source: npm package [`@sap-theming/theming-base-content`](https://github.com/SAP/theming-base-content), version 11.36.5
  (`content/Base/baseLib/baseTheme/fonts/`), the font files are used unmodified.
- Copyright: SAP SE or an SAP affiliate company and theming-base-content contributors.
- License: Apache License, Version 2.0 (the package declares `"license": "Apache-2.0"`).
  A copy of the license text as shipped in the package is at `packages/web/public/fonts/LICENSE-72-Apache-2.0.txt`
  and is available at <http://www.apache.org/licenses/LICENSE-2.0>.

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on
an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

The colour values in the "Horizon" brand (`packages/web/src/styles/tokens.css`) were chosen with reference to the
`sap_horizon` and `sap_horizon_dark` themes of the same package (Apache-2.0). No SAP logos or wordmarks are used;
"SAP" and "72" are trademarks of SAP SE. This project is not affiliated with or endorsed by SAP.

TODO before release: re-confirm that the font files themselves carry no additional licence terms beyond the package licence.
