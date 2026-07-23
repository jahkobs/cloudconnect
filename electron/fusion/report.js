'use strict';

/**
 * Generates the "SQL Runner" BI Publisher catalog objects that make arbitrary
 * SQL execution possible on a Fusion pod.
 *
 * Two objects are produced:
 *   1. A Data Model (.xdm) whose single dataset SQL is the lexical reference
 *      `&p_sql`. BI Publisher expands the `p_sql` parameter into the SQL text
 *      before parsing, so the caller controls the entire statement.
 *   2. A Report (.xdo) bound to that data model, defaulting to CSV output.
 *
 * The CatalogService.uploadObject SOAP call expects each object as a base64
 * ZIP (`xdmz` / `xdrz`). This module builds those archives with JSZip and also
 * exposes the raw XML for inspection / manual import by an administrator.
 *
 * The bound application data source defaults to `ApplicationDB_FSCM` (Financials
 * / SCM). For HCM-only pods set it to `ApplicationDB_HCM` via the connection.
 */

const JSZip = require('jszip');

const DEFAULT_DATA_SOURCE = 'ApplicationDB_FSCM';

function splitPath(reportPath) {
  const clean = reportPath.replace(/\.xdo$/i, '');
  const idx = clean.lastIndexOf('/');
  const folderPath = idx > 0 ? clean.slice(0, idx) : '/Custom/CloudConnect';
  const name = idx >= 0 ? clean.slice(idx + 1) : 'SQLRunner';
  return { folderPath, name };
}

function dataModelXml(dataSource = DEFAULT_DATA_SOURCE) {
  // rowPlacement + a text parameter used as a lexical (&p_sql) inside the SQL.
  return `<?xml version="1.0" encoding="UTF-8"?>
<dataModel xmlns="http://xmlns.oracle.com/oxp/xmlp/" version="2.0"
           xmlns:xsd="http://www.w3.org/2001/XMLSchema"
           defaultDataSourceRef="${dataSource}">
  <description><![CDATA[CloudConnect generic SQL runner. Executes the SQL passed in the p_sql parameter.]]></description>
  <dataProperties>
    <property name="include_parameters" value="true"/>
    <property name="include_null_Element" value="true"/>
    <property name="include_rowsettag" value="false"/>
    <property name="sql_monitor_report" value="false"/>
    <property name="db_fetch_size" value="500"/>
    <property name="scalable_mode" value="on"/>
  </dataProperties>
  <parameters>
    <parameter name="p_sql" dataType="xsd:string" rowPlacement="1"
               defaultValue="select 1 as col1 from dual">
      <input label="SQL"/>
    </parameter>
  </parameters>
  <dataSets>
    <dataSet name="Q_MAIN" type="simple">
      <sql dataSourceRef="${dataSource}" xmlRowTagName="G_1" nsQuery="false"
           fetchSize="500"><![CDATA[&p_sql]]></sql>
    </dataSet>
  </dataSets>
  <output rootName="DATA_DS" uniqueRowName="false">
    <nodeList name="dataStructure">
      <dataStructure tagName="DATA_DS">
        <group name="G_1" label="G_1" source="Q_MAIN"/>
      </dataStructure>
    </nodeList>
  </output>
  <eventTriggers/>
  <lexicals/>
  <valueSets/>
</dataModel>`;
}

function reportXml(dataModelUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<report xmlns="http://xmlns.oracle.com/oxp/xmlp/" version="2.0"
        defaultTemplateType="csv" showControls="true"
        onLine="true" openLinkInNewWindow="true"
        controllableFormats="true">
  <description><![CDATA[CloudConnect SQL Runner report. Returns dataset as CSV.]]></description>
  <dataModel url="${dataModelUrl}"/>
  <parameters/>
  <listOfTemplates default="CSV">
    <template templateType="csv" defaultOutputFormat="csv" viewable="true"
              label="CSV" locale="en_US" outputName="CSV" type="csv"
              active="true" applyStyleTemplate="false" default="true">
      <outputFormats>
        <outputFormat outputName="csv" default="true"/>
      </outputFormats>
    </template>
  </listOfTemplates>
  <properties/>
</report>`;
}

/**
 * Build base64 ZIP archives for the data model and report.
 * @param {string} reportPath e.g. /Custom/CloudConnect/SQLRunner.xdo
 * @param {string} [dataSource]
 * @returns {Promise<{folderPath, name, dataModel, report, dataModelXml, reportXml}>}
 */
async function buildReportArchive(reportPath, dataSource = DEFAULT_DATA_SOURCE) {
  const { folderPath, name } = splitPath(reportPath);
  const dmXml = dataModelXml(dataSource);
  const rpXml = reportXml(`${folderPath}/${name}.xdm`);

  const dmZip = new JSZip();
  dmZip.file(`${name}.xdm`, dmXml);
  const dataModel = await dmZip.generateAsync({ type: 'base64', compression: 'DEFLATE' });

  const rpZip = new JSZip();
  rpZip.file(`${name}.xdo`, rpXml);
  const report = await rpZip.generateAsync({ type: 'base64', compression: 'DEFLATE' });

  return { folderPath, name, dataModel, report, dataModelXml: dmXml, reportXml: rpXml };
}

module.exports = { buildReportArchive, dataModelXml, reportXml, splitPath, DEFAULT_DATA_SOURCE };
