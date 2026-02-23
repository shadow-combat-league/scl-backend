import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'

const execAsync = promisify(exec)

// Localhost field group and field IDs
const LOCAL_FIELD_GROUP_ID = 94
const LOCAL_FIELD_IDS = [95, 96, 97, 98, 99, 100]

async function getNextAvailableId(namespace: string): Promise<number> {
  const podName = (await execAsync(`kubectl get pods -n ${namespace} -l app=mysql -o jsonpath='{.items[0].metadata.name}'`)).stdout.trim()
  const dbPassword = (await execAsync(`kubectl get secret wordpress-secret -n ${namespace} -o jsonpath='{.data.db-password}' | base64 -d`)).stdout.trim()
  
  const result = await execAsync(
    `kubectl exec -n ${namespace} ${podName} -- sh -c "export MYSQL_PWD='${dbPassword}'; mysql -uwordpress wordpress -Nse 'SELECT MAX(ID) FROM wp_posts;'" 2>&1 | grep -v "Warning\|Using a password" | tail -1`
  )
  
  const maxId = parseInt(result.stdout.trim(), 10)
  return (isNaN(maxId) || maxId === 0) ? 200 : maxId + 1
}

async function exportFieldGroupFromLocalhost(): Promise<string> {
  console.log('📤 Exporting field group from localhost...')
  
  // Export posts
  const postsSql = (await execAsync(
    `docker exec scl-wordpress-db mysqldump -uwordpress -pwordpress wordpress wp_posts --where="ID IN (${LOCAL_FIELD_GROUP_ID},${LOCAL_FIELD_IDS.join(',')})" --no-create-info --skip-triggers --skip-add-locks --skip-disable-keys --skip-extended-insert 2>&1 | grep -v "Warning\|mysqldump\|Error\|Access denied" | grep -E "^INSERT|^--" || echo ""`
  )).stdout
  
  // Export postmeta
  const postmetaSql = (await execAsync(
    `docker exec scl-wordpress-db mysqldump -uwordpress -pwordpress wordpress wp_postmeta --where="post_id IN (${LOCAL_FIELD_GROUP_ID},${LOCAL_FIELD_IDS.join(',')})" --no-create-info --skip-triggers --skip-add-locks --skip-disable-keys --skip-extended-insert 2>&1 | grep -v "Warning\|mysqldump\|Error\|Access denied" | grep -E "^INSERT|^--" || echo ""`
  )).stdout
  
  return postsSql + '\n' + postmetaSql
}

function remapIds(sql: string, startId: number): string {
  let modified = sql
  
  // Map: 94 -> startId, 95 -> startId+1, etc.
  const idMap: Record<number, number> = {
    [LOCAL_FIELD_GROUP_ID]: startId,
  }
  
  LOCAL_FIELD_IDS.forEach((oldId, index) => {
    idMap[oldId] = startId + 1 + index
  })
  
  // Replace IDs in INSERT statements
  Object.entries(idMap).forEach(([oldIdStr, newId]) => {
    const oldId = parseInt(oldIdStr, 10)
    // Replace in wp_posts INSERT (ID is first value after VALUES)
    modified = modified.replace(
      new RegExp(`INSERT INTO \`wp_posts\` VALUES \\(${oldId},`, 'g'),
      `INSERT INTO \`wp_posts\` VALUES (${newId},`
    )
    
    // Replace in wp_postmeta INSERT (post_id is second value)
    modified = modified.replace(
      new RegExp(`\\(\\d+,${oldId},`, 'g'),
      `($1,${newId},`
    )
    
    // Replace post_parent references (94 is parent of fields 95-100)
    if (oldId === LOCAL_FIELD_GROUP_ID) {
      modified = modified.replace(
        new RegExp(`',${oldId},`, 'g'),
        `',${newId},`
      )
      modified = modified.replace(
        new RegExp(`',${oldId}\\)`, 'g'),
        `',${newId})`
      )
    }
  })
  
  return modified
}

async function importToEnvironment(sql: string, namespace: string, envName: string) {
  const podName = (await execAsync(`kubectl get pods -n ${namespace} -l app=mysql -o jsonpath='{.items[0].metadata.name}'`)).stdout.trim()
  const dbPassword = (await execAsync(`kubectl get secret wordpress-secret -n ${namespace} -o jsonpath='{.data.db-password}' | base64 -d`)).stdout.trim()
  
  const sqlFile = `/tmp/acf-import-${namespace}.sql`
  fs.writeFileSync(sqlFile, sql)
  
  console.log(`📦 Copying SQL to ${envName} pod...`)
  await execAsync(`kubectl cp ${sqlFile} ${namespace}/${podName}:/tmp/acf-import.sql`)
  
  console.log(`📥 Importing to ${envName}...`)
  const result = await execAsync(
    `kubectl exec -n ${namespace} ${podName} -- sh -c "export MYSQL_PWD=\"${dbPassword}\"; mysql -uwordpress wordpress < /tmp/acf-import.sql" 2>&1`
  )
  
  if (result.stderr && !result.stderr.includes('Warning') && !result.stderr.includes('Duplicate entry')) {
    console.error('Error:', result.stderr)
  } else {
    console.log(`✅ Import completed for ${envName}`)
  }
  
  // Verify
  console.log(`🔍 Verifying ${envName}...`)
  const verify = await execAsync(
    `kubectl exec -n ${namespace} ${podName} -- sh -c "export MYSQL_PWD=\"${dbPassword}\"; mysql -uwordpress wordpress -e 'SELECT ID, post_title, post_type FROM wp_posts WHERE post_type = \\\"acf-field-group\\\" AND post_title = \\\"Game Settings\\\";'" 2>&1 | grep -v "Warning\|Using a password"`
  )
  console.log(verify.stdout)
  
  // Verify fields
  const verifyFields = await execAsync(
    `kubectl exec -n ${namespace} ${podName} -- sh -c "export MYSQL_PWD=\"${dbPassword}\"; mysql -uwordpress wordpress -e 'SELECT COUNT(*) as field_count FROM wp_posts WHERE post_type = \\\"acf-field\\\" AND post_parent IN (SELECT ID FROM wp_posts WHERE post_type = \\\"acf-field-group\\\" AND post_title = \\\"Game Settings\\\");'" 2>&1 | grep -v "Warning\|Using a password" | tail -1`
  )
  console.log(`   Fields created: ${verifyFields.stdout.trim()}`)
}

async function main() {
  try {
    const environments = [
      { namespace: 'scl-staging', name: 'staging' },
      { namespace: 'scl', name: 'production' },
    ]
    
    for (const env of environments) {
      console.log(`\n${'='.repeat(80)}`)
      console.log(`🚀 Importing Game Settings field group to ${env.name.toUpperCase()}`)
      console.log(`${'='.repeat(80)}\n`)
      
      // Check if already exists
      const dbPassword = (await execAsync(`kubectl get secret wordpress-secret -n ${env.namespace} -o jsonpath='{.data.db-password}' | base64 -d`)).stdout.trim()
      const podName = (await execAsync(`kubectl get pods -n ${env.namespace} -l app=mysql -o jsonpath='{.items[0].metadata.name}'`)).stdout.trim()
      
      const check = await execAsync(
        `kubectl exec -n ${env.namespace} ${podName} -- sh -c "export MYSQL_PWD=\"${dbPassword}\"; mysql -uwordpress wordpress -Nse 'SELECT ID FROM wp_posts WHERE post_type = \\\"acf-field-group\\\" AND post_title = \\\"Game Settings\\\" LIMIT 1;'" 2>&1 | grep -v "Warning\|Using a password" | tail -1`
      )
      
      if (check.stdout.trim() && !isNaN(parseInt(check.stdout.trim(), 10))) {
        console.log(`✅ Field group already exists in ${env.name} (ID: ${check.stdout.trim()})`)
        continue
      }
      
      // Get next available ID
      const startId = await getNextAvailableId(env.namespace)
      console.log(`✅ Next available ID: ${startId}\n`)
      
      // Export from localhost
      const sql = await exportFieldGroupFromLocalhost()
      
      if (!sql || typeof sql !== 'string' || sql.trim().length < 100) {
        console.error(`❌ Failed to export from localhost for ${env.name}`)
        continue
      }
      
      // Remap IDs
      const remappedSql = remapIds(sql, startId)
      
      // Import to environment
      await importToEnvironment(remappedSql, env.namespace, env.name)
    }
    
    console.log(`\n${'='.repeat(80)}`)
    console.log(`✅ Done! Check WordPress admin in both staging and production.`)
    console.log(`${'='.repeat(80)}\n`)
  } catch (error: any) {
    console.error('❌ Error:', error.message)
  }
}

main()
