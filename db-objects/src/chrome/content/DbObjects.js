/*  Copyright 2011, 2012, 2013, 2014, 2015, 2016 Peter Kehl
    This file is part of SeLite Db Objects.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Lesser General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Lesser General Public License for more details.

    You should have received a copy of the GNU Lesser General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
"use strict";

Components.utils.import( 'chrome://selite-misc/content/SeLiteMisc.js' );
Components.utils.import('chrome://selite-db-objects/content/DbStorage.js');
Components.utils.import('chrome://selite-db-objects/content/Db.js');
Components.utils.import( 'chrome://selite-settings/content/SeLiteSettings.js' );

//var console= Components.utils.import("resource://gre/modules/Console.jsm", {}).console;

SeLiteData.narrowByPrefix= {
    filter: function narrowByPrefixFilter( table, tableOrJoinAlias, narrowByValue ) {
        return tableOrJoinAlias+ "." +table.narrowColumn+ " LIKE '" +narrowByValue+ "%' ";//@TODO escape
    },
    inject: function narrowByPrefixInject( unfilteredValue, narrowByValue='' ) {
        return narrowByValue+ unfilteredValue;
    }
};

/** @constructs SeLiteData.Db
 *  @param {SeLiteData.Storage} storage Underlying lower-level storage object.
 *  @param {string} [tableNamePrefix] optional prefix, which will be applied to all tables (except for tables that have noNamePrefix=true when constructed). If not set, then storage.tableNamePrefix is used (if any).
 *  @param {boolean} [generateInsertKey=false] Whether all tables with single-column primary key should have the key values generated (based on the maximum existing key) on insert. SeLiteData.Table constructor can override this on per-table basis.
 *  @param {object}  narrowMethod An anonymous object
 *      {filter: function(string fieldOrAlias, string narrowByValue) => string SQL condition,
 *       inject: function(string unfilteredValue, string narrowByValue) => string to insert to DB (unescaped)
 *      }.
 *      Default narrow method. It will apply to all tables, except for ones that have their own narrowMethod. It escapes special characters.
 **/
//@TODO check that ESDoc generates optional parameter flag for narrowMethod, even though it's not maekred as optional in the comment
SeLiteData.Db= function Db( storage, tableNamePrefix, generateInsertKey=false, narrowMethod=SeLiteData.narrowByPrefix ) {
    /** @type {SeLiteData.Storage} storage*/
    this.storage= storage;
    /** @type {string} tableNamePrefix*/
    this.tableNamePrefix= tableNamePrefix;
    this.generateInsertKey= generateInsertKey;
    this.narrowMethod= narrowMethod;
};

/** @return {string} Table prefix, or an empty string. It never returns undefined.
 * */
SeLiteData.Db.prototype.tablePrefix= function tablePrefix() {
    return SeLiteMisc.fieldDefined( this, 'tableNamePrefix', this.storage.tablePrefix() );
};

/** @constructs SeLiteData.Table
 *  @param {Object} prototype Anonymous object {
 *      db: SeLiteData.Db instance,
 *      noNamePrefix: boolean, optional; if true, then it cancels effect of prototype.db.tableNamePrefix (if set),
 *      name: string table name,
 *      columns: array of string column names,
 *      primary: string primary key name (one column), or array of multiple string column names; optional - 'id' by default,
 *      generateInsertKey: boolean, like parameter generateInsertKey of SeLiteData.Db(). If specified and different to prototype.db.generateInsertKey, then prototype.generateInsertKey overrides it (even if db.generateInsertKey is true but here prototype.generateInsertKey is false).
 *      narrowColumn: string, optional. Name of column used to narrow down operating set or records.
 *      narrowMaxWidth: number, optional. Maximum number of characters when narrowing down. Applied to Settings field extensions.selite-settings.common.narrowBy.
 *      narrowMethod: function, optional. See SeLiteData.Db().
 */
SeLiteData.Table= function Table( prototype ) {
    /** @type {SeLiteData.Db} */
    this.db= prototype.db;
    var prefix= SeLiteMisc.field( prototype, 'noNamePrefix', this.db.tableNamePrefix );
    /** @var {string} name Be careful - this excludes prefix (if any). So this is a 'logical' name. It's mostly used when setting up SeLiteData.RecordSetFormula instances, table aliases in joins etc. If you need to generate custom SQL query, use method nameWithPrefix() to get the full name of the table.
     */
    this.name= prototype.name;

    this.columns= prototype.columns;
    this.primary= prototype.primary || 'id';
    typeof this.primary==='string' || Array.isArray(this.primary) || SeLiteMisc.fail( 'prototype.primary must be a string or an array.' );
    !Array.isArray(this.primary) || this.primary.length>1 || SeLiteMisc.fail( 'prototype.primary must contain multiple column names, if it is an array.' );
    this.generateInsertKey= SeLiteMisc.field( prototype, 'generateInsertKey', this.db.generateInsertKey );
    this.generateInsertKey= this.generateInsertKey || false;
    this.narrowColumn= SeLiteMisc.field( prototype, 'narrowColumn' );
    this.narrowMaxWidth= SeLiteMisc.field( prototype, 'narrowMaxWidth' ); //@TODO use<- pass table object to narrowMethod()
    this.narrowMethod= SeLiteMisc.field( prototype, 'narrowMethod', this.db.narrowMethod );
};

SeLiteData.Table.prototype.nameWithPrefix= function nameWithPrefix() {
    return this.noNamePrefix
        ? this.name
        : this.db.tablePrefix()+this.name;
};

/** Insert the given record to the DB.
 *  @param {SeLiteData.Record} record
 *  @TODO
 *  - save primary key, if auto-generated: table.db.storage.lastInsertedRow( table.nameWithPrefix(), [table.primary] )[ table.primary ];
 *  - if record is linked to a RecordHolder, update .originals
 * */
SeLiteData.Table.prototype.insert= function insert( originalRecord, sync=false ) {
    var record= SeLiteMisc.objectClone( originalRecord );
    var columns= [];
    var columnPlaceholders= []; // :columnName, or SeLiteData.SQLExpression literal
    var bindings= {};
    if( this.generateInsertKey && SeLiteMisc.field(record, this.primary)===undefined/* If the client provided a value for the primary key, don't generate it.*/ ) {
        //<editor-fold defaultstate="collapsed" desc="Ensure the table has single-value primary key.">
        typeof this.primary==='string' || SeLiteMisc.fail( "The table or DB has generateInsertKey set, but table " +this.name +" uses multi-column primary key: " +this.primary );
        //</editor-fold>
        record[ this.primary ]= new SeLiteData.SqlExpression( "(SELECT MAX(" +this.primary+ ") FROM " +this.nameWithPrefix()+ ")+1" );
    }
    for( var column in record ) {
        if( typeof record[column]==='function' ) {// This handles any functions defined on the instance, including toString() (which comes from Object constructor)
            continue;
        }
        this.columns.indexOf(column)>=0 || SeLiteMisc.fail( "Column " +column+ " is not among columns defined for table " +this.nameWithPrefix() );
        columns.push( column );
        if( !(record[column] instanceof SeLiteData.SqlExpression) ) {
            bindings[ column ]= record[ column ];
            columnPlaceholders.push( ':' +column );
        }
        else {
            columnPlaceholders.push( record[column] );
        }
    }
    var query= 'INSERT INTO ' +this.nameWithPrefix()+ '('+ columns.join(', ')+ ') '+
        'VALUES (' +columnPlaceholders.join(', ')+ ')';
    var execution= this.db.storage.execute( query, bindings, {}, /*expectResult:*/false, sync );
    // Fetch the auto-generated primary one-column key (not a multi-column key), if applicable (whether it came from DB or from the expression injected above)
    if( typeof this.primary==='string' && SeLiteMisc.field(bindings, this.primary)===undefined ) {
        var lastInsertedRow= sync
            ? this.db.storage.lastInsertedRow( this.nameWithPrefix(), [this.primary], true )
            : execution.then(
                ignored => this.db.storage.lastInsertedRow( this.nameWithPrefix(), [this.primary] )
              );
        if( sync ) {
            this._injectInsertedPrimary( originalRecord, lastInsertedRow );
        }
        else {
            return lastInsertedRow.then(
                lastInsertedRowValue=> {
                    this._injectInsertedPrimary( originalRecord, lastInsertedRowValue );
                    return undefined;
                }
            );
        }
    }
    return execution;
};

/** Set primary key in given originalRecord object to the primary key of the last inserted record.
 *  @private
 *  @param {object} originalRecord Record object to set the primary key in.
 *  @param {object} lastInsertedRow
 *  @return undefined
 * */
SeLiteData.Table.prototype._injectInsertedPrimary= function _injectInsertedPrimary( originalRecord, lastInsertedRow ) {
    originalRecord[ this.primary ]= lastInsertedRow[ this.primary ];
};

/** Create on-the-fly a new SeLiteData.RecordSetFormula instance. Do not store/cache it anywhere.
 * @param {object} [params] See parameter params of SeLiteData.RecordSetFormula(). This is on top of (or it overrides) 'table' and 'columns'.
 * @param {object} [prototype] See parameter prototype of SeLiteData.RecordSetFormula().
 * @return {SeLiteData.RecordSetFormula}
 * */
SeLiteData.Table.prototype.formula= function formula( params, prototype ) {
    var mergedParams= SeLiteMisc.objectsMerge( params, {
        table: this,
        columns: { [this.name]: SeLiteData.RecordSetFormula.ALL_FIELDS }
    } );
    return new SeLiteData.RecordSetFormula( mergedParams, prototype );
};
            
/** @private Not used directly outside of this file */
function readOnlyPrimary( field ) {
    throw new Error( "This field '" +field+ "' is a primary key and therefore read-only." );
}

/** @private Not used directly outside of this file */
function readOnlyOriginal( field ) {
    throw new Error( "Original record is read-only, therefore this can't change field '" +field+ "'." );
}

/** @private Not used directly outside of this file */
function readOnlyJoined( field ) {
    throw new Error( "Field '" +field+ "' is from a joined record, therefore it can't be changed." );
}

/** @constructs Abstract class, parent of RecordHolder and RecordSetHolder.
 * */
function RecordOrSetHolder() {}
RecordOrSetHolder.prototype= {
    select: function select() { throw new Error('Abstract'); },
    selectOne: function selectOne() { throw new Error('Abstract'); },
    insert: function insert() { throw new Error('Abstract'); },
    update: function update() { throw new Error('Abstract'); },
    remove: function remove() { throw new Error('Abstract'); }
};

/** @constructs An object which represents a holder of one DB record.
 *  It allows us to have methods to manipulate the record, without a name conflict
 *  between names of those methods and fields of the record itself.
 *  <br/>Keys (field names) in this.record and this.original (if set) are the aliased
 *  column names, as defined in the respective SeLiteData.RecordSetFormula (and as retrieved from DB).
 *  See insert().
 *  @private Not used directly outside of this file.
 *  @param {SeLiteData.RecordSetFormula|RecordSetHolder|null} object recordSetHolderOrFormula An instance of either SeLiteData.RecordSetHolder, or of SeLiteData.RecordSetFormula, or null. If it's a formula,
 *  then this.original won't be set, and you can modify this.record. You probably
 *  want to pass a SeLiteData.RecordSetFormula instance if you intend to use this RecordHolder with insert() only.
 *  @param object plainRecord Plain record from the result of the SELECT (using the column aliases, including any joined fields).
 *  Optional; if not present/null/empty object, then this.record will be set to an empty object
 *  (the passed one, if any; a new one otherwise) and its fields won't be checked by watch() - so you can
 *  set its fields later, and then use insert().
 *  DO NOT externally change existing .record field of RecordHolder instance after it was created,
 *  because this.record object won't be the same as plainRecord parameter passed here.
 *  this.record object links to a new SeLiteData.Record instance.
 **/
function RecordHolder( recordSetHolderOrFormula, plainRecord ) {
    RecordOrSetHolder.call( this );
    /** @type {RecordSetHolder}*/
    this.recordSetHolder= null;
 /*  I would like to use use Firefox JS Proxies https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy
 *  -- try javascript:"use strict"; function MyProxy( target ) { Proxy.constructor.call(this, target, this ); } MyProxy.prototype.save= function() {}; var o=new MyProxy(); o.save()
 *  -- No need to set MyProxy.prototype.constructor to Proxy.constructor*/
    if( recordSetHolderOrFormula instanceof SeLiteData.RecordSetFormula ) {
        this.recordSetHolder= new RecordSetHolder( recordSetHolderOrFormula );
    }
    else
    if( recordSetHolderOrFormula instanceof RecordSetHolder ) {
        this.recordSetHolder= recordSetHolderOrFormula;
    }
    else if( recordSetHolderOrFormula!==null ) {
        throw new Error("RecordHolder() expects the first parameter to be an instance of RecordSetHolder or SeLiteData.RecordSetFormula." );
    }
    /** @type {SeLiteData.Record} */
    this.record= new SeLiteData.Record( plainRecord, this );
    if( recordSetHolderOrFormula instanceof SeLiteData.RecordSetFormula && Object.keys(this.record).length>0 ) {
        this.setOriginalAndWatchEntries();
    }
}
RecordHolder.prototype= Object.create( RecordOrSetHolder.prototype );
RecordHolder.prototype.constructor= RecordHolder;

/*** Constructor used for object that represents a record in a DB.
 *   @param {[?(Object|boolean)]} Object with the record's data, or null/false/undefined.
 *   @param {[?RecordHolder]} recordHolder Respective instance of private class RecordHolder, or null/undefined.
 **/
SeLiteData.Record= function Record( data, recordHolder ) {
    // Set the link from record to its record holder. The field for this link is non-iterable.
    // @TODO here and other calls to defineProperty(): Consider replacing with http://es6-features.org/#SymbolType
    Object.defineProperty( this, SeLiteData.Record.RECORD_TO_HOLDER_FIELD, { value: recordHolder } );
    if( data ) {
        SeLiteMisc.objectCopyFields( data, this );
    }
};

/** This is a name of Javascript field, used in instances of SeLiteData.Record,
    for which the field value is an instance of private class RecordHolder.
    If this string ever gets in conflict with a field name in your DB table, change it here.
    @private
*/
SeLiteData.Record.RECORD_TO_HOLDER_FIELD= 'RECORD_TO_HOLDER_FIELD';

SeLiteData.Record.prototype.toString= function toString() {
    return SeLiteMisc.objectToString( this );
};

/** @private Not a part of public API.
 *  @param {SeLiteData.Record} instance
 *  @return {RecordHolder} for that instance.
 **/
SeLiteData.recordHolder= function recordHolder( record ) {
    SeLiteMisc.ensureInstance( record, SeLiteData.Record, 'record' );
    return record[SeLiteData.Record.RECORD_TO_HOLDER_FIELD];
};

/** Generate a string used for indexing, based on the value of primary key column(s).
 *  @return {string}
 * */
RecordHolder.prototype.primaryKeyCompound= function primaryKeyCompound() {
    var primary= this.recordSetHolder.formula.table.primary;
    if( typeof primary==='string' ) {
        return this.record[primary]
    }
    var object= {};
    for( var primaryCompound of primary ) {
        object[ primaryCompound ]= this.record[ primaryCompound ];
    }
    return JSON.stringify(object);
};

RecordHolder.prototype.setOriginalAndWatchEntries= function setOriginalAndWatchEntries() {
    this.original= {};

    var columnsToAliases= this.recordSetHolder.formula.columnsToAliases( this.recordSetHolder.formula.table.name );
    var columnAliases= SeLiteMisc.objectValues( columnsToAliases, true );
    // this.original will store own columns only
    for( var field in columnAliases ) {
        this.original[field]= this.record[field];
        this.original.watch( field, readOnlyOriginal );
    }
    Object.seal( this.original ); // This has effect only in strict mode

    // Don't allow change of joined columns:
    for( field in this.record ) {
        if( !(field in columnAliases) ) {
            this.record.watch( field, readOnlyJoined );
        }
    }
    // Don't allow change of primary key column(s). That's because RecordSetHolder.originals are indexed by primary key.
    var primaryKeyColumns= typeof this.recordSetHolder.formula.table.primary==='string'
        ? [this.recordSetHolder.formula.table.primary]
        : this.recordSetHolder.formula.table.primary;
    for( var primaryKeyColumn of primaryKeyColumns ) {
        this.record.watch( primaryKeyColumn, readOnlyPrimary );
    }
};

RecordHolder.prototype.select= function select( dontNarrow=false ) { throw new Error( "@TODO. In the meantimes, use RecordSetHolder.select() or SeLiteData.RecordSetFormula.select()."); };

RecordHolder.prototype.selectOne= function selectOne( dontNarrow=false ) { throw new Error( "@TODO. In the meantime, use RecordSetHolder.selectOne() or SeLiteData.RecordSetFormula.selectOne()."); };

// @TODO Consider: RecordHolder.insert() which is linked to an existing RecordSetHolder, and it adds itself to that recordSetHolder. - But then the recordSetHolder may not match its formula anymore - have a flag/handler for that?
/** This saves this.record into main table of the formula. As defined by RecordHolder() constructor,
 *  keys/field names in this.record are the column aliases. This re-maps them to the DB columns before inserting.
 *  @TODO set/modify this.originals.
 *  @param {boolean} sync
 *  @return {(number|string|Promise)} value of the primary key for the new record, if auto-generated (whether auto-generated by DB or by SeLite based on the maximum existing key) and if  it's a one column key; undefined otherwise.
 **/
RecordHolder.prototype.insert= function insert( sync=false ) {
    // Fields set in formula's onInsert{} override any fields with the same name in this.record
    for( var field in this.recordSetHolder.formula.onInsert ) {
        var value= typeof this.recordSetHolder.formula.onInsert[field]==='function'
            ? this.recordSetHolder.formula.onInsert[field]()
            : this.recordSetHolder.formula.onInsert[field];
        this.record[ field ]= value;
    }
    var entries= this.ownEntries();
    if( this.recordSetHolder.formula.generateInsertKey && SeLiteMisc.field( entries, this.recordSetHolder.formula.table.primary)===undefined/* If the client provided a value for the primary key, don't generate it.*/ ) {
        //<editor-fold defaultstate="collapsed" desc="Ensure the table has single-value primary key.">
        typeof this.recordSetHolder.formula.table.primary==='string' || SeLiteMisc.fail( "The formula, table or DB has generateInsertKey set, but table " +this.recordSetHolder.formula.table +" uses multi-column primary key: " +this.recordSetHolder.formula.table.primary );
        //</editor-fold>
        entries= SeLiteMisc.objectsMerge( {
                [this.recordSetHolder.formula.table.primary]: new SeLiteData.SqlExpression( "(SELECT MAX(" +this.recordSetHolder.formula.table.primary+ ") FROM " +this.recordSetHolder.formula.table.nameWithPrefix()+ ")+1")
            },
            entries
        );
    }
    var insertion= this.recordSetHolder.storage().insertRecord( {
        table: this.recordSetHolder.formula.table.nameWithPrefix(),
        entries: entries,
        fieldsToProtect: typeof this.recordSetHolder.formula.table.primary==='string'
            ? [this.recordSetHolder.formula.table.primary]
            : [], // We allow change of multi-column primary key columns, otherwise it would be impractical to update them
        debugQuery: this.recordSetHolder.formula.debugQuery,
        sync: sync
    });
    // Fetch the auto-generated primary one-column key, if applicable (whether it came from DB or from the expression injected above)
    if( typeof this.recordSetHolder.formula.table.primary==='string'
        && ( SeLiteMisc.field(entries, this.recordSetHolder.formula.table.primary)===undefined || entries[this.recordSetHolder.formula.table.primary] instanceof SeLiteData.SqlExpression )
    ) {
        var lastInserted= sync
            ? this.recordSetHolder.storage().lastInsertedRow( this.recordSetHolder.formula.table.nameWithPrefix(), [this.recordSetHolder.formula.table.primary], true )
            : insertion.then( ignored => this.recordSetHolder.storage().lastInsertedRow( this.recordSetHolder.formula.table.nameWithPrefix(), [this.recordSetHolder.formula.table.primary] ) );
        if( sync ) {
            this.recordSetHolder.formula.table._injectInsertedPrimary( this.record, lastInserted );
        }
        else {
            return lastInserted.then( lastInsertedKeyValue=> this.recordSetHolder.formula.table._injectInsertedPrimary( this.record, lastInsertedKeyValue ) );
        }
    }
    return insertion;
};

/** This generates a transformation of this.record, with any column alias names transformed to the original columns (as defined for the table). It serves when updating/inserting this.record that was previously loaded from the DB (potentially with column aliases).
 * */
RecordHolder.prototype.ownEntries= function ownEntries() {
    var allAliasesToSource= this.recordSetHolder.formula.allAliasesToSource();
    for( var field in this.record ) {
        if( !(field in allAliasesToSource) ) {
            throw new Error( "Trying to insert/update a record in table '" +this.recordSetHolder.formula.table.nameWithPrefix()+
                "' with field '" +field+ "' which is not a listed alias in this formula." );
        }
    }

    var columnsToAliases= this.recordSetHolder.formula.columnsToAliases(this.recordSetHolder.formula.table.name);
    var entries= {};
    for( var field in columnsToAliases ) {
        // Some columns listed in the formula may have not be set (if using default values). Let's pass only the ones present.
        if( columnsToAliases[field] in this.record ) {
            entries[ field ]= this.record[ columnsToAliases[field] ];
        }
    }
    return entries;
};

/** Update the underlying record.
 *  @param {boolean} sync
 *  @returns {undefined|Promise}
 *  */
RecordHolder.prototype.update= function update( sync=false ) {
     // Fields set in formula's onUpdate{} override any fields with the same name in this.record
    for( var field in this.recordSetHolder.formula.onUpdate ) {
        var value= typeof this.recordSetHolder.formula.onUpdate[field]==='function'
            ? this.recordSetHolder.formula.onUpdate[field]()
            : this.recordSetHolder.formula.onUpdate[field];
        this.record[ field ]= value;
    }
    var entries= this.ownEntries();
    var updating= this.recordSetHolder.storage().updateRecordByPrimary( {
        table: this.recordSetHolder.formula.table.name,
        primary: this.recordSetHolder.formula.table.primary,
        entries: entries,
        debugQuery: this.recordSetHolder.formula.debugQuery,
        sync: sync
    });
    if( sync ) {
        this.setOriginalAndWatchEntries();
    }
    else {
        return updating.then( ignored => this.setOriginalAndWatchEntries() );
    }
};

/** Remove the record.
 *  @param {boolean} sync
 *  @return {undefined|Promise}
 * */
RecordHolder.prototype.remove= function remove( sync=false ) {
    return this.recordSetHolder.storage().removeRecordByPrimary( this.recordSetHolder.formula.table.nameWithPrefix(), this.recordSetHolder.formulate.table.primary, this.record, sync );
};

/** @constructs Constructor of formula objects.
 *  @param {object} params - Object serving as an associative array; optional, in form {
 *      table: SeLiteData.Table instance
 *      alias: string, alias for this table, used in SQL, optional.
 *          @TODO Check this old documentation - not applicable anymore: object, optional, in form { table-name: columns-alias-info } where each columns-alias-info is of mixed-type:
            - string column alias prefix (it will be prepended in front of all column names); or
            - SeLiteData.RecordSetFormula.ALL_FIELDS (all fields listed in the table object will be selected, unaliased); or
            - an alias map object listing all columns that are to be selected, mapped to string alias, or mapped to true/1 if not aliased; or
            - an array, listing one or more of the following
            --- all unaliased columns
            ---- optional object(s) which is an alias map {string colum name: string alias}; such a map must map to string alias (it must not map to true/1)
            --- optional SeLiteData.RecordSetFormula.ALL_FIELDS indicating usage of all columns under their names (unaliased), unless any map object(s) map them
            Each alias must be unique; that will be checked by SeLiteData.RecordSetFormula constructor (--@TODO).
            The column list must list the primary key of the main table, and it must not be aliased. Their values must exist
            - i.e. you can't have a join that selects records from join table(s) for which there is no record in the main table.
            That's because RecordSetHolder.originals{} are indexed by it.
 *      columns: Object serving as an associative array {
    *      string tableName: mixed, either
    *       - SeLiteData.RecordSetFormula.ALL_FIELDS, or
    *       - an array of either
    *           - string columnName, or
    *           - object serving as a map, with exactly one entry { string columnName: string alias}
    *         or
    *       - an anonymous object {
    *              string columnName: string alias; or
    *              string columnName: true - to mark that the column should be retrieved - used when you need an alias for other column(s)
    *         }
    *      }
 *      joins: Similar to but not exact as the same field passed to SeLiteData.Storage.getRecords().
 *          Array [
 *              of objects {
                    table: table object;
                    alias: string table alias, optional;
                    type: string type 'left' or ''; optional
                    on: string join condition
                }
            ]
 *      fetchCondition: String SQL condition,
 *      fetchMatching
 *      parameterNames
 *      sort
 *      sortDirection
 *      indexBy - either a field name (string), or an array of them. If it's a single field name, it will be converted into an array (containing that single field name). Optional; if not set and the table has a single-column primary key then it's set to that key; otherwise there's no indexing.
 *      indexUnique
 *      process
 *      debugQuery
 *      debugResult
 *      generateInsertKey: boolean, like parameter generateInsertKey of SeLiteData.Db(). Optional; if present, then it overrides table.generateInsertKey (whether it's set here to true or false, regardless of whether table.generateInsertKey is true or false).If not set, then it's copied from prototype.generateInsertKey (if defined), or from this.table.generateInsertKey.
 *      onInsert: value to fill in on insert, or function to call to get such a value
 *      onUpdate: value to fill in on update, or function to call to get such a value
 *  }
 *  @param object prototype Instance of SeLiteData.RecordSetFormula which serves as the prototype for the new object. Optional.
 *  Any fields not set in params will be inherited from prototype (if present), as they are at the time of calling this constructor.
 *  Any fields set in params will override respective fields in prototype (if any),
 *  except for field(s) present in params and set to null - then values will be copied from prototype, (if present).
 *  @TODO putCondition, putMatching
 *  @TODO Consider making some of parameterNames optional. fetchMatching already can contain callback functions, so extend the mechanism
 *  to pass values of all actual parameters from user's select() call. Similar for putMatching, if we implement it. Possibly the similar for fetchCondition (and for putCondition, if we implement it).
 *  @TODO consider applying fetchMatching in other ways than just SQL = comparison. E.g. LIKE, <>, IS NULL, IS NOT NULL. The same for passing optional column filters to SeLiteData.Storage.prototype.getRecords() via its params.parameters field.
 **/
SeLiteData.RecordSetFormula= function RecordSetFormula( params, prototype ) {
    SeLiteMisc.PrototypedObject.call( this, prototype );
    params= params ? params : {};
    SeLiteMisc.objectClone( params, ['table', 'alias', 'columns', 'joins', 'fetchCondition', 'fetchMatching', 'parameterNames', 'sort',
            'sortDirection', 'indexBy', 'indexUnique', 'process', 'debugQuery', 'debugResult',
            'onInsert', 'onUpdate' ],
        [], this );
    if( params.generateInsertKey!==undefined ) {
        this.generateInsertKey= SeLiteMisc.fieldDefined( params, 'generateInsertKey', this.table.generateInsertKey );
    }
    if( !Array.isArray(this.joins) ) {
        throw new Error( "params.joins must be an array (of objects), if present." );
    }

    // The following doesn't apply to indexing of RecordSetHolder.originals.
    if( SeLiteMisc.field(this, 'indexBy')===undefined && this.table && this.table.primary && typeof this.table.primary==='string' ) {
        this.indexBy= this.table.primary;
        SeLiteMisc.field(this, 'indexUnique')===undefined || this.indexUnique || SeLiteMisc.fail( 'Formula for table ' +this.table.name+ " doesn't specify indexBy field, therefore it should not specify indexUnique as false.");
        this.indexUnique= true;
    }
    if( this.indexBy && !Array.isArray(this.indexBy) ) {
        this.indexBy= [this.indexBy];
    }
    // @TODO check that all own table columns' aliases are unique: Object.keys( SeLiteMisc.objectReverse( ownColumns() ) )
    // @TODO similar check for joined columns?
};
//SeLiteData.RecordSetFormula.prototype.constructor= SeLiteData.RecordSetFormula; //@TODO Do I need this line?
SeLiteData.RecordSetFormula.ALL_FIELDS= ["ALL_FIELDS"]; // I compare this by identity (using === and !==). That allow user column alias prefix 'ALL_FIELDS', if (ever) need be.

SeLiteData.RecordSetFormula.prototype.alias= null;
SeLiteData.RecordSetFormula.prototype.columns= {};
SeLiteData.RecordSetFormula.prototype.joins= [];
SeLiteData.RecordSetFormula.prototype.fetchCondition= null;
// fetchMatching contains the values unescaped and unqoted; they will be escaped and quoted as needed.
// Each value must represent SQL constant (string or non-string), or a function returning such value.
// String values will be quoted, so they can't be SQL expressions. Javascript null value won't be quoted
// and it will generate an IS NULL statement; other values will generate = comparison.
// If matching-value is a function, it will be called at the time the data is to be fetched from DB.
// Use it to return values which vary during runtime.
SeLiteData.RecordSetFormula.prototype.fetchMatching= {};

// Names of any parameters.
// They will be escaped & quoted as appropriate and they will replace occurrances of their placeholders :<parameter-name>.
// The placeholders can be used in joins[i].on and in fetchCondition, fetchMatching, putCondition, putMatching.
SeLiteData.RecordSetFormula.prototype.parameterNames= [];
SeLiteData.RecordSetFormula.prototype.sort= null;
SeLiteData.RecordSetFormula.prototype.sortDirection= 'ASC';

/** A function which will be called after fetching and indexing the records. Its two parameters will be
 *  records (RecordSet) and RecordSetHolder's bind parameters (if any). It should return RecordSet instance (either the same one, or a new one).
 **/
SeLiteData.RecordSetFormula.prototype.process= null;
SeLiteData.RecordSetFormula.prototype.debugQuery= false;
SeLiteData.RecordSetFormula.prototype.debugResult= false;
// Don't set SeLiteData.RecordSetFormula.prototype.generateInsertKey, because it would interfere with how SeLiteData.RecordSetFormula() sets this.generateInsertKey.

SeLiteData.RecordSetFormula.prototype.onInsert= {}; // aliasedFieldName: string value or function; used on insert; it overrides any existing value for that field
SeLiteData.RecordSetFormula.prototype.onUpdate= {}; // aliasedFieldName: string value or function; used on update; it overrides any existing value for that field

/** @param {string} tableName Table name - either the name of the main table of the formula, or an alias of any join. It excludes any table prefix.
 *  @return {(SeLiteData.Table|null)} A table for this table/alias name. Null if none.
 * */
SeLiteData.RecordSetFormula.prototype.tableByName= function tableByName( tableName ) {
    if( this.table.name===tableName ) {
        return this.table;
    }
    for( var join of this.joins ) {
        if( join.table.name===tableName ) {
            return join.table;
        }
    }
    return null;
};

/** @param {string} tableName Table name (without prefix).
 *  @return {object} { string given table's column name: string column alias or the same column name (if no alias) }.
 *  That differs from definition field columns passed to SeLiteData.RecordSetFormula() constructor, which allows
 *  unaliased column names to be mapped to true/1. Here such columns get mapped to themselves (to the column names);
 *  that makes it easy to use with SeLiteMisc.objectValues() or SeLiteMisc.objectReverse().
 **/
SeLiteData.RecordSetFormula.prototype.columnsToAliases= function columnsToAliases( tableName ) {
    var columnsDefinition= this.columns[ tableName ];
    var result= {};

    var listingAllColumns= columnsDefinition===SeLiteData.RecordSetFormula.ALL_FIELDS ||
        typeof columnsDefinition==="array" && columnsDefinition.indexOf(SeLiteData.RecordSetFormula.ALL_FIELDS)>=0;
    if( listingAllColumns ) {
        var allColumns= this.tableByName(tableName).columns;
        for( var i=0; i<allColumns.length; i++ ) {
            result[ allColumns[i] ]= allColumns[i];
        }
    }
    if( columnsDefinition!==SeLiteData.RecordSetFormula.ALL_FIELDS ) {
        if( Array.isArray(columnsDefinition) ) {
            for( var j=0; j<columnsDefinition.length; j++ ) { //@TODO use loop: for( .. of ..), once NetBeans supports it
                var columnOrMap= columnsDefinition[j];
                if( typeof columnOrMap ==='string' ) {
                    result[ columnOrMap ]= columnOrMap;
                }
                else
                if( typeof columnOrMap ==='object' && columnOrMap!==SeLiteData.RecordSetFormula.ALL_FIELDS ) {
                    for( var column in columnOrMap ) {
                        result[ column ]= columnOrMap[column];
                    }
                }
            }
        }
        else {
            for( var column in columnsDefinition ) {
                var alias= columnsDefinition[column];
                if( typeof alias!=='string' ) {
                    if( !alias ) { // only accept true/1
                        continue;
                    }
                    alias= column; // no specific alias, so map the column to itself
                }
                result[ column ]= alias;
            }
        }
    }
   return result;
};

/** A bit like columnsToAliases(), but this returns the aliases for all columns used by
 *  the formula (from all its tables), each mapped to an object containing the table and the (unaliased) column name.
 *  @return {object} { string column-alias: {
 *              table: table object,
 *              column: column-name
 *            },
 *            ...
 *          }
 **/
SeLiteData.RecordSetFormula.prototype.allAliasesToSource= function allAliasesToSource() {
    // @TODO update tableByName() to be similar to this, reuse:
    var tableNamesToTables= { [this.table.name]: this.table };
    this.joins.forEach( function(join) {
        tableNamesToTables[ join.table.name ]= join.table;
    } );

    var result= {};
    for( var tableName in tableNamesToTables ) {
        var columnsToAliases= this.columnsToAliases( tableName );
        for( var column in columnsToAliases ) {
            result[ columnsToAliases[column] ]= {
                table: tableNamesToTables[tableName],
                column: column
            };
        }
    }
    return result;
};

/** This returns SeLiteData.RecordSet object, i.e. the records themselves.
 *  @see RecordSetHolder.select().
 *  @return {Array|Promise}
 **/
SeLiteData.RecordSetFormula.prototype.select= function select( parametersOrCondition, dontNarrow=false, sync=false ) {
    return new RecordSetHolder(this, parametersOrCondition ).select( dontNarrow, sync );
};

/** This returns the SeLiteData.Record object, i.e. the record itself.
 *  @see RecordSetHolder.selectOne()
 *  @return {Object|Promise}
 **/
SeLiteData.RecordSetFormula.prototype.selectOne= function selectOne( parametersOrCondition, dontNarrow=false, sync=false ) {
    return new RecordSetHolder(this, parametersOrCondition ).selectOne( dontNarrow, sync );
};

/** SeLiteData.RecordSet serves as an associative array, containing SeLiteData.Record object(s), indexed by SeLiteMisc.collectByColumn(records, [formula.indexBy] or formula.indexBy, formula.indexUnique)
 *  for the formula of recordSetHolder. It is iterable, but it doesn't guarantee the order of entries.
 *  It also keeps a non-iterable reference to recordSetHolder.
 *  @param object recordSetHolder of class RecordSetHolder
 **/
SeLiteData.RecordSet= function RecordSet( recordSetHolder ) {
    SeLiteMisc.ensureInstance( recordSetHolder, RecordSetHolder, 'recordSetHolder' );
    // Set the link from record to its record holder. The field for this link is non-iterable.
    Object.defineProperty( this, SeLiteData.RecordSet.RECORDSET_TO_HOLDER_FIELD, { value: recordSetHolder } );
};
// This is configurable - if it ever gets in conflict with an index key in your DB table, change it here.
SeLiteData.RecordSet.RECORDSET_TO_HOLDER_FIELD= 'RECORDSET_TO_HOLDER_FIELD';

/** @private
 *  @param SeLiteData.RecordSet instance
 *  @return {RecordSetHolder} for that instance.
 **/
function recordSetHolder( recordSet ) {
    SeLiteMisc.ensureInstance( recordSet, SeLiteData.RecordSet, 'recordSet' );
    return recordSet[SeLiteData.RecordSet.RECORDSET_TO_HOLDER_FIELD];
};

/** @private
 *  @return {RecordOrSetHolder}
 * */
SeLiteData.recordOrSetHolder= function recordOrSetHolder( recordOrSet ) {
    if( recordOrSet instanceof SeLiteData.Record ) {
        return SeLiteData.recordHolder(recordOrSet);
    }
    else
    if( recordOrSet instanceof SeLiteData.RecordSet ) {
        return recordSetHolder(recordOrSet);
    }
    else {
        throw new Error( "Parameter recordOrSet must be an instance of SeLiteData.Record or SeLiteData.RecordSet, but it's:\n" +SeLiteMisc.objectToString(recordOrSet, 3) );
    }
};

/** @constructs It keeps a set of RecordHolders objects.
 *  @private
 *  @param {SeLiteData.RecordSetFormula} formula Instance of SeLiteData.RecordSetFormula.
 *  @param {Object|Array} [parametersOrCondition] Parameters or SQL condition.
 *  If a string, then it's an SQL condition that will be AND-ed to other criteria of the formula (e.g. matching).
 *  If an object, then it serves as an associative array, listing actual parameters in form {string parameter-name: mixed parameter-value, ...}.
 *  Any parameter values which typeof is not 'string' or 'number'
 *  will passed to formula's process() function (if set), but it won't be passed
 *  as a binding parameter (it won't apply to any parameters in condition/fetchMatching/join).
 *  Any values with typeof 'number' will be transformed into strings.
 *  That's because SQLite only allows binding values with typeof 'string'.
 *   If parameter-name matches either a table column name/alias or a join name/alias, it must not match any entry in parameterNames - @TODO factor out a similar check from RecordSetHolder.prototype.select() - see unnamedParamFilters; then re-apply the check here. Such a parameter
 *   is then used as a subfilter, filtering by its respective column/alias, adding an 'AND' to the overall SQL WHERE part.
 *   Note that if parameter-name matches two or more columns with same name (from two or more tables), the condition will probably fail
 *   with an error - then use aliases. TODO clarify
 **/
function RecordSetHolder( formula, parametersOrCondition={} ) {
    RecordOrSetHolder.call( this );
    formula instanceof SeLiteData.RecordSetFormula || SeLiteMisc.fail();
    this.formula= formula;
    this.parametersOrCondition= parametersOrCondition;
    this.holders= {}; // Object serving as an associative array { primary key value: RecordHolder instance }
    this.recordSet= new SeLiteData.RecordSet( this );
    this.originals= {}; // This will be set to object { primary-key-value: original object... }
}
RecordSetHolder.prototype= Object.create( RecordOrSetHolder.prototype );
RecordSetHolder.prototype.constructor= RecordSetHolder;

RecordSetHolder.prototype.storage= function storage() {
    return this.formula.table.db.storage;
};

/** This narrows down formula.table, OPTIONAL(TODO:) unless its primary key is present in either formula.fetchMatching or this.parametersOrCondition (if this.parametersOrCondition is an object, not a string). It doesn't check formula.fetchCondition, neither this.parametersOrCondition if it's a string. *  It doesn't narrow down any joins.
 *  @param {boolean} dontNarrow Whether not to narrow. Use e.g. for personal logins (other than logins created by the script).
 *  @return {SeLiteData.RecordSet|Promise} object
 * */
RecordSetHolder.prototype.select= function select( dontNarrow=false, sync=false ) {
    SeLiteMisc.objectDeleteFields( this.recordSet );
    /** @type {SeLiteData.RecordSetFormula} */
    var formula= this.formula;

    var columns= {};
    // @TODO potentially use allAliasesToSource() to simplify the following
    for( var tableName in formula.columns ) { // excluding prefix
        var columnsToAliases= formula.columnsToAliases( tableName );
        var tableAlias; // tableAlias, if specified
        var table; // Table object for tableName. Used to get table name with prefix if tableAlias is undefined.
        if( tableName==formula.table.name ) {
            tableAlias= formula.alias;
            table= formula.table;
        }
        else {
            var join;
            for( var iteratedJoin of formula.joins ) {
                if( iteratedJoin.table.name===tableName ) {
                    join= iteratedJoin;
                    break;
                }
            }
            if( join===undefined ) {
                throw new Error( "Formula defined columns for table '" +tableName+ "' but it's not the main table neither a join table." );
            }
            tableAlias= join.alias;
            table= join.table;
        }
        if( !tableAlias ) {
            tableAlias= table.nameWithPrefix();
        }
        var columnAliases= {};
        for( var column in columnsToAliases ) {
            columnAliases[ tableAlias+ '.' +column ]= columnsToAliases[column]!==column
                ? columnsToAliases[column]
                : true;
        }
        columns= SeLiteMisc.objectsMerge( columns, columnAliases );
    }

    var matching= {};
    for( var field in formula.fetchMatching ) {
        var matchingValue= typeof formula.fetchMatching[field]==='function'
            ? formula.fetchMatching[field]()
            : formula.fetchMatching[field];
        matching[field]= matchingValue;
    }
    var usingCondition= typeof this.parametersOrCondition==='string';
    if( !usingCondition ) {
        var allAliasesToSource= formula.allAliasesToSource();
        for( var paramName in this.parametersOrCondition ) {
            if( formula.parameterNames.indexOf(paramName)<0 ) {
                continue;
            }
            if( paramName in allAliasesToSource ) {
                continue;
            }
            throw new Error( "Unexpected query parameter with name '" +paramName+ "' and value: " +this.parametersOrCondition[paramName] );
        }
    }
    var joins= [];
    formula.joins.forEach( function(join) {
        var joinClone= SeLiteMisc.objectClone(join);
        joinClone.table= join.table.nameWithPrefix();
        joins.push( joinClone );
    } );
    var condition= usingCondition
        ? this.parametersOrCondition
        : null;
    var parameters= !usingCondition
        ? SeLiteMisc.objectClone(this.parametersOrCondition)
        : {};
    var parametersForProcessHandler= !usingCondition
        ? this.parametersOrCondition
        : {};
    var unnamedParamFilters= []; // Filter conditions based on entries from parameters that match a table/join column/alias.
                           // Such entries in parameters then serve as AND subfilters, rather than as named parameters. @TODO factor out; check in RecordSetHolder() constructor, store there on the instance and reuse here - as a protective copy below
    for( var param in parameters ) {
        // If param matches a table column name/alias, or a column name/alias, then it's not a named parameter.
        var paramIsColumnOrAlias= false; // This will be true if param is moved to unnamedParams.
        paramIsColumnOrAlias= formula.table.columns.indexOf(param)>=0;
        if( !paramIsColumnOrAlias ) {
            // @TODO Do I need the following loop? This should be a subset of ones from formula.joins. I check formula.joins below anyway.
            for( var tableName in formula.columns ) {
                if( typeof formula.columns[tableName]==='object' ) {
                    for( var columnName in formula.columns[tableName] ) {
                        var columnAliasOrTrue= formula.columns[tableName][columnName];
                        if( param===columnAliasOrTrue ) {
                            paramIsColumnOrAlias= true;
                            break;
                        }
                    }
                }
                if( typeof formula.columns[tableName]==='array' &&  formula.columns[tableName]!==SeLiteData.RecordSetFormula.ALL_FIELDS ) {
                    for( var i=0; i<v.length; i++ ) {
                        var columnNameOrMap= formula.columns[tableName][i];
                        if( typeof columnNameOrMap==='object' ) {
                            var columnName= Object.keys( columnNameOrMap )[0];
                            var columnAliasOrTrue= columnNameOrMap[ columnName ];
                            if( param===columnAliasOrTrue ) {
                                paramIsColumnOrAlias= true;
                                break;
                            }
                        }
                    }
                }
            }
            // loop over join columns and aliases
            loopOverJoins:
            for( var i=0; i<formula.joins.length; i++ ) {
                var entry= formula.joins[i];
                var tableNameOrAlias= entry.alias
                    ? entry.alias
                    : entry.table.name;
                for( var j=0; j<entry.table.columns.length; j++ ) {
                    var column= entry.table.columns[j];
                    if( param===column || param===tableNameOrAlias+'.'+column ) {
                        paramIsColumnOrAlias= true;
                        break loopOverJoins;
                    }
                }
            }
        }
        // don't use `else {`, because paramIsColumnOrAlias could have changed above.
        if( paramIsColumnOrAlias ) {
            // @TODO Move the following validation to SeLiteData.RecordSetFormula()? For that factor out the above logic that detemines paramIsColumn. Apply a similar validation to RecordSetHolder() constructor?
            !(param in this.formula.parameterNames ) || SeLiteMisc.fail( "RecordSetHolder.select() received a parameter " +param+ " which matches a column or alias, but it also matches one of parameterNames of SeLiteData.RecordSetFormula instance." );
            unnamedParamFilters.push(
                (parameters[param]!==null
                 ? param+ '=' +
                    (typeof parameters[param]==='string'
                     ? this.storage().quote( parameters[param] )
                     : parameters[param]
                    )
                 : param+ ' IS NULL'
                )
            );
            delete parameters[param];
            continue;
        }
        if( typeof parameters[param]==='number' ) {
            parameters[param]= ''+parameters[param];
        }
        else
        if( typeof parameters[param]!=='string') {
            delete parameters[param];
        }
    }
    
    var conditions= unnamedParamFilters.slice(); // @TODO use unnamedParamFilters.slice() as a protective copy via SeLiteMisc.objectClone() -> factor the above into constructor
    var settings= SeLiteSettings.Module.forName( 'extensions.selite-settings.common' );
    var narrowBy= settings.getField( 'narrowBy' ).getDownToFolder().entry;
    if( narrowBy!==undefined && !dontNarrow ) {
        let hasNarrowColumn= false;
        // @TODO loop - once we support formula.tables array
        if( formula.table.narrowColumn ) {
            // @TODO Optional: run the following only if formula.table.primary is not in formula.fetchMatching neither this.parametersOrCondition (as an object, not a string).
            let alias= formula.alias || formula.table.nameWithPrefix();
            let narrowByShortened= formula.table.narrowMaxWidth
                ? narrowBy.substr( 0, formula.table.narrowMaxWidth )
                : narrowBy;
            conditions.push( formula.table.narrowMethod(formula.table, alias, narrowByShortened) );
            hasNarrowColumn= true;
        }
        /* TODO Should we narrow throguh joins?
        for( var join of joins ) {
            if( join.table.narrowColumn ) {
                let alias= join.alias || join.table.nameWithPrefix();
                let narrowByShortened= join.table.narrowMaxWidth
                    ? narrowBy.substr( 0, join.table.narrowMaxWidth )
                    : narrowBy;
                let narrowCondition= join.table.narrowMethod( join.table, alias, narrowBy );
                if( join.type && join.type.toLowerCase().startsWith('left') ) {
                    narrowCondition= '( ' +narrowCondition+ " OR " +alias+ "." +join.table.narrowColumn+ " IS NULL )";
                }
                conditions.push( narrowCondition );
                hasNarrowColumn= true;
            }
        }*/
        if( !hasNarrowColumn ) {
            SeLiteMisc.fail( "You're expecting narrowing down the matches, but there's no narrowColumn set." );
        }
    }

    formula.fetchCondition===null || conditions.splice( 0, 0, formula.fetchCondition );
    condition===null || conditions.splice( 0, 0, condition );
    var selected= this.storage().getRecords( {
        table: formula.table.nameWithPrefix()+
            (formula.alias
            ? ' ' +formula.alias
            : ''),
        joins: joins,
        columns: columns,
        matching: matching,
        condition: this.storage().sqlAnd( ...conditions ),
        parameters: parameters,
        parameterNames: formula.parameterNames,
        sort: formula.sort,
        sortDirection: formula.sortDirection,
        debugQuery: formula.debugQuery,
        debugResult: formula.debugResult,
        sync: sync
    } );
    if( sync ) {
        return this._handleSelectResult( formula, selected );
    }
    else {
        return selected.then( data => this._handleSelectResult( formula, data ) );
    }
};

RecordSetHolder.prototype._handleSelectResult= function _handleSelectResult( formula, data ) {
    var unindexedRecords= [];
    this.originals= {};
    for( var j=0; j<data.length; j++ ) {
        var holder= new RecordHolder( this, data[j] );
        this.holders[ holder.primaryKeyCompound() ]= holder;
        unindexedRecords.push( holder.record );
        this.originals[ holder.primaryKeyCompound() ]= holder.original;
    }
    if( formula.indexBy ) {
        SeLiteMisc.collectByColumn( unindexedRecords, formula.indexBy, formula.indexUnique, this.recordSet );
    }
    else {
        this.recordSet= unindexedRecords;
    }
    if( formula.process ) {
        this.recordSet= formula.process( this.recordSet, parametersForProcessHandler );
    }
    return this.recordSet;
};

/** This runs the query just like select(). Then it checks whether there was exactly 1 result row.
 *  If yes, it returns that row (SeLiteData.Record object). Otherwise it throws an exception.
 *  @return {
 **/
RecordSetHolder.prototype.selectOne= function selectOne( dontNarrow=false, sync=false ) {
    var selecting= this.select( dontNarrow, sync );
    return sync
        ? SeLiteData.Storage.expectOneRow( this.recordSet )
        : selecting.then( recordSetIgnored => SeLiteData.Storage.expectOneRow( this.recordSet ) );
};

RecordSetHolder.prototype.insert= function insert() { throw new Error( "@TODO if need be" );
}

/** Update the underlying record.
 *  @param {boolean} sync
 *  @returns {undefined|Promise}
 *  */
RecordSetHolder.prototype.update= function update( sync ) {
        for( var i=0; i<this.holders.length; i++ ) {
        /** @type {RecordHolder} */
        var recordHolder= this.holders[i];
        return recordHolder.update( sync );
    }
};

/** This removes the record holder and its record from this set holder and its set. It doesn't
 *  remove the actual DB record.
 **/
RecordSetHolder.prototype.removeRecordHolder= function removeRecordHolder( recordHolder ) {
    var primaryKeyCompound= recordHolder.primaryKeyCompound();
    delete this.holders[ primaryKeyCompound ];
    delete this.recordSet[ SeLiteMisc.indexOfRecord(this.recordSet, recordHolder.record) ];
    delete this.originals[ primaryKeyCompound ];
};

RecordSetHolder.prototype.remove= function remove() { throw "TODO";
};

RecordSetHolder.prototype.replace= function replace() {throw 'todo';
};

var EXPORTED_SYMBOLS= [];